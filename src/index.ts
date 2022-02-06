import { Buf } from './node/Buf'
try {
    const buf = new Buf(Buffer.from("abc"))
    console.dir(buf)
    console.log(buf.readStringNUL(), buf.offset)
} catch (e) {
    console.error(e)
}
setTimeout(() => { }, 1000000)