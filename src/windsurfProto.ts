/**
 * Windsurf Protobuf 编解码工具
 * 参考: 文档中的 encodeStringField / decodeProtoFields
 * 开发者: Ti
 */

/**
 * 编码 varint (protobuf 变长整数)
 * @param n - 要编码的非负整数
 * @returns Buffer
 */
export function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let value = n;
  while (value > 127) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return Buffer.from(bytes);
}

/**
 * 解码 varint
 * @returns { value: 解码值, pos: 新位置 }
 */
export function decodeVarint(data: Buffer, pos: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  let newPos = pos;
  while (newPos < data.length) {
    const byte = data[newPos++];
    value |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) { break; }
    shift += 7;
  }
  return { value, pos: newPos };
}

/**
 * 编码 protobuf string 字段
 * tag = (fieldNumber << 3) | 2 (wire type 2 = length-delimited)
 * @param fieldNumber - 字段编号
 * @param value - 字符串值
 * @returns Buffer
 */
export function encodeStringField(fieldNumber: number, value: string): Buffer {
  const buf = Buffer.from(String(value || ''), 'utf8');
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(buf.length),
    buf,
  ]);
}

/**
 * 解码 protobuf 消息，提取所有 string 字段
 * 仅支持 wire type 0 (varint 跳过) 和 2 (length-delimited 视为 string)
 * @param buf - protobuf 消息字节
 * @returns Map<fieldNumber, stringValue>
 */
export function decodeProtoFields(buf: Buffer): Map<number, string> {
  const fields = new Map<number, string>();
  let pos = 0;
  while (pos < buf.length) {
    const tagResult = decodeVarint(buf, pos);
    pos = tagResult.pos;
    const tag = tagResult.value;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      /* Length-delimited (string / bytes / nested message) */
      const lenResult = decodeVarint(buf, pos);
      pos = lenResult.pos;
      const len = lenResult.value;
      const val = buf.subarray(pos, pos + len).toString('utf8');
      fields.set(fieldNum, val);
      pos += len;
    } else if (wireType === 0) {
      /* Varint, 跳过 */
      const skipResult = decodeVarint(buf, pos);
      pos = skipResult.pos;
    } else {
      /* 未知 wire type, 停止解析 */
      break;
    }
  }
  return fields;
}

/**
 * 通用 protobuf 解析结果节点（用于深度解析嵌套消息）
 * - key 形如 `int_14` / `string_2` / `subMsg_1` / `i32_3` / `i64_5`
 */
export interface ProtoNode {
  [key: string]: number | string | ProtoNode | undefined;
}

/**
 * 深度解析 protobuf，自动识别嵌套消息 / 字符串 / 整数
 * 适用于响应结构复杂的 API (如 GetPlanStatus)
 *
 * 字段命名规则:
 * - `int_<N>`     → varint (wire type 0)
 * - `string_<N>`  → 无法解析为子消息的 length-delimited (视为字符串)
 * - `subMsg_<N>`  → length-delimited 且能递归解析出至少一个字段
 * - `i32_<N>`     → fixed32
 * - `i64_<N>`     → fixed64
 *
 * @param buf - protobuf 消息字节
 * @param depth - 递归深度 (防止爆栈)
 */
export function parseProto(buf: Buffer, depth: number = 0): ProtoNode {
  const result: ProtoNode = {};
  if (buf.length === 0 || depth > 8) { return result; }

  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos = tag.pos;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 2) {
      /* length-delimited: 先当子消息试，失败回退为 string */
      const lenRes = decodeVarint(buf, pos);
      pos = lenRes.pos;
      const len = lenRes.value;
      const sub = buf.subarray(pos, pos + len);
      pos += len;

      let parsedAsSubMsg: ProtoNode | null = null;
      if (len > 0 && depth < 8) {
        try {
          const sr = parseProto(sub, depth + 1);
          if (Object.keys(sr).length > 0 && isLikelyValidMessage(sub, sr)) {
            parsedAsSubMsg = sr;
          }
        } catch { /* ignore */ }
      }

      if (parsedAsSubMsg) {
        result[`subMsg_${fieldNum}`] = parsedAsSubMsg;
      } else {
        result[`string_${fieldNum}`] = sub.toString('utf8');
      }
    } else if (wireType === 0) {
      const v = decodeVarint(buf, pos);
      pos = v.pos;
      result[`int_${fieldNum}`] = v.value;
    } else if (wireType === 5) {
      /* fixed32 */
      if (pos + 4 > buf.length) { break; }
      result[`i32_${fieldNum}`] = buf.readUInt32LE(pos);
      pos += 4;
    } else if (wireType === 1) {
      /* fixed64 (按 number 返回，精度可能丢失但满足 timestamp 场景) */
      if (pos + 8 > buf.length) { break; }
      result[`i64_${fieldNum}`] = Number(buf.readBigUInt64LE(pos));
      pos += 8;
    } else {
      break;
    }
  }
  return result;
}

/**
 * 启发式判断解析结果是否像一个真正的子消息
 * - 解析是否消耗了大部分字节 (避免误把 UTF-8 字符串当子消息)
 */
function isLikelyValidMessage(_raw: Buffer, parsed: ProtoNode): boolean {
  /* 至少有一个字段，且所有键都是合法格式 */
  const keys = Object.keys(parsed);
  if (keys.length === 0) { return false; }
  const validKey = /^(int|string|subMsg|i32|i64)_\d+$/;
  return keys.every(k => validKey.test(k));
}
