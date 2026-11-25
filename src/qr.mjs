// src/qr.mjs 零依赖二维码编码器（ISO/IEC 18004）+ PNG 输出。
//
// # 为什么要自己写
//
// 绑定门户要在**别人的手机**上出码，最稳的形态是服务器直接吐一张 PNG：
//
//	① 插件是从 GitHub 直装的，多一个 npm 依赖就多一层装不上 / 版本漂移的风险；
//	② 二维码图案是纯算法，自己实现只有 200 行，且可以离线自证（用解码器回读）；
//	③ 走第三方「二维码图片 API」会把 state 泄露给外部服务，等于把绑定码交出去。
//
// # 能力边界
//
//	字节模式（UTF-8）· 版本 1~10（L 级最多 271 字节）· ECC L/M/Q/H · 自动掩码
//	不支持：数字/字母数字模式压缩、Kanji、结构化追加 —— 授权地址用不到。
//
// # 自证方式
//
//	`npm test` 里只校验结构（尺寸/定位图形/静区）；真正的正确性判据是
//	用解码器回读：tests 之外的本机验证脚本会把 PNG 交给 OpenCV 的
//	QRCodeDetector 解一次，解出的字符串必须**逐字节等于**输入。

import { deflateSync } from "node:zlib"

/** ECC 级别的格式信息位（ISO 18004 §8.9 的表）。 */
const ECL_FORMAT_BITS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 })

/** 每个纠错块的 ecc 码字数；下标 = 版本号（0 位占位）。 */
const ECC_CODEWORDS_PER_BLOCK = Object.freeze({
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
})

/** 纠错块数量；下标 = 版本号（0 位占位）。 */
const NUM_ERROR_CORRECTION_BLOCKS = Object.freeze({
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
})

/** 本实现支持的最大版本（再大只是容量，用不到）。 */
export const MAX_VERSION = 10

/** 版本 1~40 里「除纠错码字外的可用模块数」。 */
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

/** 某个版本 + ECC 级别的**数据**码字数（不含纠错码字）。 */
function numDataCodewords(ver, ecl) {
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
  )
}

/** 对齐图形的中心坐标（版本 1 没有对齐图形）。 */
function alignmentPatternPositions(ver) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// ── GF(256) / Reed-Solomon ──────────────────────────────────────────────

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
}

/** GF(256) 乘法。 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** 生成多项式（次数 = ecc 码字数）的系数。 */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/** 余数（= 纠错码字）。 */
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()
    result.push(0)
    for (let i = 0; i < divisor.length; i += 1) result[i] ^= gfMul(divisor[i], factor)
  }
  return result
}

// ── 编码 ────────────────────────────────────────────────────────────────

/** 比特缓冲（按位写，最后按字节取出）。 */
function bitBuffer() {
  const bits = []
  return {
    bits,
    push(value, len) {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
    },
  }
}

/**
 * 把字节串排成「数据码字」（含模式、长度、终止符、填充）。
 *
 * @param {Buffer} bytes
 * @param {number} ver
 * @param {"L"|"M"|"Q"|"H"} ecl
 * @returns {number[]}
 */
function buildDataCodewords(bytes, ver, ecl) {
  const capacityBits = numDataCodewords(ver, ecl) * 8
  const bb = bitBuffer()
  bb.push(0b0100, 4) // 字节模式
  bb.push(bytes.length, ver <= 9 ? 8 : 16)

  for (const b of bytes) bb.push(b, 8)

  // 终止符最多 4 位
  bb.push(0, Math.min(4, capacityBits - bb.bits.length))
  // 补到字节边界
  bb.push(0, (8 - (bb.bits.length % 8)) % 8)

  const out = []
  for (let i = 0; i < bb.bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bb.bits[i + j]
    out.push(byte)
  }
  // 填充字节 0xEC / 0x11 交替
  for (let pad = 0xec; out.length < capacityBits / 8; pad ^= 0xec ^ 0x11) out.push(pad)
  return out
}

/**
 * 分块 → 加纠错 → 交错（ISO 18004 §7.6）。
 *
 * @param {number[]} data
 * @param {number} ver
 * @param {"L"|"M"|"Q"|"H"} ecl
 * @returns {number[]}
 */
function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver]
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)

  const blocks = []
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)
    const dat = data.slice(k, k + datLen)
    k += datLen
    const ecc = rsRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0) // 占位，最后交错时跳过
    blocks.push(dat.concat(ecc))
  }

  const result = []
  for (let i = 0; i < blocks[0].length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i])
    }
  }
  return result
}

/** 一个模块网格 + 「这个位置是不是功能图形」的标记。 */
function newGrid(size) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false))
  return { size, modules, isFunction }
}

function setFunction(g, x, y, dark) {
  g.modules[y][x] = Boolean(dark)
  g.isFunction[y][x] = true
}

/** 定位图形（三个角上的 7×7 回字）。 */
function drawFinder(g, cx, cy) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const x = cx + dx
      const y = cy + dy
      if (x >= 0 && x < g.size && y >= 0 && y < g.size) setFunction(g, x, y, dist !== 2 && dist !== 4)
    }
  }
}

/** 对齐图形（5×5）。 */
function drawAlignment(g, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

/** 格式信息（两份，含固定的暗模块）。 */
function drawFormatBits(g, ecl, mask) {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i) => ((bits >>> i) & 1) !== 0
  const size = g.size

  for (let i = 0; i <= 5; i += 1) setFunction(g, 8, i, bit(i))
  setFunction(g, 8, 7, bit(6))
  setFunction(g, 8, 8, bit(7))
  setFunction(g, 7, 8, bit(8))
  for (let i = 9; i < 15; i += 1) setFunction(g, 14 - i, 8, bit(i))

  for (let i = 0; i < 8; i += 1) setFunction(g, size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i += 1) setFunction(g, 8, size - 15 + i, bit(i))
  setFunction(g, 8, size - 8, true)
}

/** 版本信息（版本 ≥ 7 才有）。 */
function drawVersionBits(g, ver) {
  if (ver < 7) return
  let rem = ver
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (ver << 12) | rem
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) !== 0
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFunction(g, a, b, dark)
    setFunction(g, b, a, dark)
  }
}

/** 按之字形把码字写进矩阵。 */
function drawCodewords(g, data) {
  let i = 0
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < g.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? g.size - 1 - vert : vert
        if (!g.isFunction[y][x] && i < data.length * 8) {
          g.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i += 1
        }
      }
    }
  }
}

/** 掩码函数（ISO 18004 §7.8.2）。 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return false
  }
}

function applyMask(g, mask) {
  for (let y = 0; y < g.size; y += 1) {
    for (let x = 0; x < g.size; x += 1) {
      if (!g.isFunction[y][x] && maskBit(mask, x, y)) g.modules[y][x] = !g.modules[y][x]
    }
  }
}

/** 掩码罚分（规则 1~4，越小越好）。 */
function penaltyScore(g) {
  const size = g.size
  const m = g.modules
  let result = 0

  // 规则 1：同色连续 ≥5
  for (let y = 0; y < size; y += 1) {
    let run = 1
    for (let x = 1; x < size; x += 1) {
      if (m[y][x] === m[y][x - 1]) run += 1
      else {
        if (run >= 5) result += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) result += 3 + (run - 5)
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1
    for (let y = 1; y < size; y += 1) {
      if (m[y][x] === m[y - 1][x]) run += 1
      else {
        if (run >= 5) result += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) result += 3 + (run - 5)
  }

  // 规则 2：2×2 同色块
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = m[y][x]
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3
    }
  }

  // 规则 3：类定位图形的 1:1:3:1:1（两侧各 4 个亮模块）
  const pat = [true, false, true, true, true, false, true]
  const light = [false, false, false, false]
  const seq = pat.concat(light)
  const rev = light.concat(pat)
  const matchAt = (get, i, arr) => {
    for (let k = 0; k < arr.length; k += 1) if (get(i + k) !== arr[k]) return false
    return true
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x + seq.length <= size; x += 1) {
      const get = (i) => m[y][x + i]
      if (matchAt(get, 0, seq) || matchAt(get, 0, rev)) result += 40
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y + seq.length <= size; y += 1) {
      const get = (i) => m[y + i][x]
      if (matchAt(get, 0, seq) || matchAt(get, 0, rev)) result += 40
    }
  }

  // 规则 4：深浅比例偏离 50%
  let dark = 0
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (m[y][x]) dark += 1
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += Math.max(0, k * 10)

  return result
}

/**
 * 编码成模块矩阵。
 *
 * @param {string} text 任意 UTF-8 文本
 * @param {{ecl?: "L"|"M"|"Q"|"H"}} [opts]
 * @returns {{version: number, size: number, modules: boolean[][], mask: number, text: string}}
 */
export function qrMatrix(text, opts = {}) {
  const ecl = String(opts.ecl ?? "L").toUpperCase()
  // ⚠ M 级的格式位是 0，不能用 truthy 判断
  if (!Object.prototype.hasOwnProperty.call(ECL_FORMAT_BITS, ecl)) throw new Error(`未知的纠错级别：${ecl}`)
  const str = String(text ?? "")
  const bytes = Buffer.from(str, "utf8")
  if (bytes.length === 0) throw new Error("空文本无法编码")

  let ver = 0
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const capacityBits = numDataCodewords(v, /** @type {any} */ (ecl)) * 8
    const needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8
    if (needBits <= capacityBits) {
      ver = v
      break
    }
  }
  if (!ver) throw new Error(`文本太长（${bytes.length} 字节 > 版本 ${MAX_VERSION} 的容量）`)

  const data = buildDataCodewords(bytes, ver, /** @type {any} */ (ecl))
  const all = addEccAndInterleave(data, ver, /** @type {any} */ (ecl))

  const size = ver * 4 + 17
  const g = newGrid(size)

  // ① 定时图形（第 6 行 / 第 6 列的黑白相间）——漏了它整张图就解不出来
  for (let i = 0; i < size; i += 1) {
    setFunction(g, 6, i, i % 2 === 0)
    setFunction(g, i, 6, i % 2 === 0)
  }

  drawFinder(g, 3, 3)
  drawFinder(g, size - 4, 3)
  drawFinder(g, 3, size - 4)

  const align = alignmentPatternPositions(ver)
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)
      if (!corner) drawAlignment(g, align[i], align[j])
    }
  }

  drawFormatBits(g, /** @type {any} */ (ecl), 0)
  drawVersionBits(g, ver)
  drawCodewords(g, all)

  let bestMask = 0
  let bestPenalty = Infinity
  /** @type {boolean[][]|null} */
  let bestModules = null
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(g, mask)
    drawFormatBits(g, /** @type {any} */ (ecl), mask)
    const p = penaltyScore(g)
    if (p < bestPenalty) {
      bestPenalty = p
      bestMask = mask
      bestModules = g.modules.map((row) => row.slice())
    }
    applyMask(g, mask) // 复原
  }

  return { version: ver, size, modules: /** @type {boolean[][]} */ (bestModules), mask: bestMask, text: str }
}

// ── PNG 输出 ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 编码成 PNG（8 位灰度，1 模块 = `scale` 像素，四周 `border` 模块静区）。
 *
 * @param {string} text
 * @param {{ecl?: "L"|"M"|"Q"|"H", scale?: number, border?: number}} [opts]
 * @returns {Buffer}
 */
export function qrPng(text, opts = {}) {
  const { modules, size } = qrMatrix(text, opts)
  const scale = Math.max(1, Math.min(32, Math.floor(Number(opts.scale) || 8)))
  const border = Math.max(0, Math.min(16, Math.floor(Number(opts.border ?? 4))))
  const dim = (size + border * 2) * scale

  // 每行：1 字节 filter(0) + dim 字节灰度
  const raw = Buffer.alloc(((dim + 1) * dim))
  for (let py = 0; py < dim; py += 1) {
    const rowStart = py * (dim + 1)
    raw[rowStart] = 0
    const my = Math.floor(py / scale) - border
    for (let px = 0; px < dim; px += 1) {
      const mx = Math.floor(px / scale) - border
      const dark = my >= 0 && my < size && mx >= 0 && mx < size ? modules[my][mx] : false
      raw[rowStart + 1 + px] = dark ? 0 : 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0)
  ihdr.writeUInt32BE(dim, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type：灰度
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
