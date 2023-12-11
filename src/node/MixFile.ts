import * as fs from "fs";
type FileHandle = fs.promises.FileHandle;
export class MixFile {
  public onreadSplitFile1: () => Promise<FileHandle | null> = async () => null;
  public onreadSplitFile2: () => Promise<FileHandle | null> = async () => null;

  public outputFile1: FileHandle;
  public outputFile2: FileHandle;

  constructor(outputFile1: FileHandle, outputFile2: FileHandle) {
    this.outputFile1 = outputFile1;
    this.outputFile2 = outputFile2;
  }
  private async readFile(fileHandle: FileHandle, position: number, length: number = 100 * 1024 * 1024) {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await fileHandle.read({ buffer, length, position });
    return buffer.subarray(0, bytesRead);
  }
  private go() {}
}

function find<E, T extends Array<E> | Buffer>(
  arr1: T,
  arr2: T,
  maxTimes = Infinity,
  judge: (value1: T[0], value2: T[0]) => boolean = (a, b) => a === b
): null | { main: T; child: T; index: number } {
  const maxIndex = Math.min(arr1.length, arr2.length);
  let output: null | { main: T; child: T; index: number } = null;
  const indexOf = (arrA: T, arrB: T, index: number) => {
    /** 判断arrB在不在arrA里面 */
    const end = Math.min(maxIndex, arrB.length, maxTimes);
    for (let j = 0; j < end; j++) {
      if (!judge(arrA[index + j], arrB[j])) return;
    }
    output = { main: arrA, child: arrB, index };
    return;
  };

  for (let i = 0; i < maxIndex; i++) {
    /** 判断arr1在不在arr2里面 */
    indexOf(arr1, arr2, i);
    if (output) return output;
    /** 判断arr2在不在arr1里面 */
    indexOf(arr2, arr1, i);
    if (output) return output;
  }
  return null;
}

const readFile = (path: string) => {
  let buf1 = fs.readFileSync(path);
  buf1 = buf1.subarray(buf1.indexOf("data") + 8);
  for (let i = 0; i < buf1.length; i++) {
    if (!judge(buf1[i], 0)) {
      buf1 = buf1.subarray(i);
      break;
    }
  }
  return buf1;
};
const judge = (a: number, b: number) => {
  const diff = Math.abs(a - b);
  return diff < 8 || diff > 248;
};
async function go() {
  const buf1 = readFile("1.wav");
  const buf2 = readFile("2.wav");
  const out1 = await fs.promises.open("out1.pcm", "w");
  const out2 = await fs.promises.open("out2.pcm", "w");
  let p1 = 0;
  let p2 = 0;
  while (1) {
    /** 计算差异 */
    const splitBuf1 = buf1.subarray(p1);
    const splitBuf2 = buf2.subarray(p2);
    if (splitBuf1.length === 0 || splitBuf2.length === 0) break;
    const out = find(splitBuf1, splitBuf2, 1920, judge);
    if (out) {
      const { main, child, index } = out;
      console.log("差异点", index);
      if (index) {
        if (splitBuf1 === main) {
          await Promise.all([out1.write(main.subarray(0, index)), out2.write(Buffer.alloc(index))]);
          p1 += index;
        } else {
          await Promise.all([out2.write(main.subarray(0, index)), out1.write(Buffer.alloc(index))]);
          p2 += index;
        }
      }
    } else {
      console.log("没找到差异点");
      await Promise.all([out1.write(buf1.subarray(p1, (p1 += 960))), out2.write(buf2.subarray(p2, (p2 += 960)))]);
      continue;
      //break;
    }

    /** 相同部分 */
    let same = 0;
    do {
      if (judge(buf1[p1 + same], buf2[p2 + same])) {
        same++;
      } else {
        break;
      }
    } while (p1 + same < buf1.length && p2 + same < buf2.length);
    console.log("相同部分", same);
    await Promise.all([out1.write(buf1.subarray(p1, (p1 += same))), out2.write(buf2.subarray(p2, (p2 += same)))]);
  }
  console.log(buf1.subarray(p1), buf2.subarray(p2));
  fs.writeFile("yu1.pcm", buf1.subarray(p1), () => {});
  fs.writeFile("yu2.pcm", buf2.subarray(p2), () => {});
  // await Promise.all([out1.write(buf1.subarray(p1)), out2.write(buf2.subarray(p2))]);
  await out1.close();
  await out2.close();
}
go();
