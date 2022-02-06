
export class Buf {
    public offset: number;
    public buf: Buffer;
    constructor(buf: Buffer, offset?: number) {
        this.buf = buf
        this.offset = offset ?? 0;
    }
    public numberToBuffer(number: number) {

    }
    public readStringNUL(length?: number, offset?: number) {
        offset = offset ?? this.offset;
        length = Math.min(length || Math.max(this.buf.indexOf(0, offset) + 1 - offset, 0) || Infinity, this.buf.length - offset + 1);
        this.offset += length;
        return String(this.buf.slice(offset, this.offset - 1))
    }
    public writeStringNUL(str: string | Buffer) {
        this.buf = Buffer.concat([this.buf, Buffer.from(str), Buffer.alloc(1).fill(0)]);
        return this.buf;
    }
}

