enum EConsole {
  up,
  down,
  right,
  left,
  cleanLineAfter = "\x1b[K",
}
// const logs: string[] = [];
export class Console {
  private lastWriteLines: string[] = [];
  public write(str: string) {
    const newLines = str.split("\n");
    const oldLines = this.lastWriteLines;
    // logs.push(oldLines.join("\n") + "------------" + newLines.join("\n"));
    const out: Array<EConsole | string> = [];
    /** 移到行首 */
    if (oldLines.length) this.toLineStart(oldLines[oldLines.length - 1], out);

    for (let lineIndex = oldLines.length - 1; lineIndex >= 0; lineIndex--) {
      //   /** 最后一行的数据 */
      //   let oldLastLine: string | undefined;
      if (lineIndex >= newLines.length && oldLines.pop()) {
        /** 清空这一行的数据 */
        // this.toLineStart(oldLastLine, out);
        out.push(EConsole.cleanLineAfter);
        // curPoint.y--;
      }
      if (lineIndex) out.push(EConsole.up);
    }
    let lastLine = oldLines[0] || "";
    /** 移到行尾 */
    this.toLineStart(lastLine, out, EConsole.right);

    // out.push("哈哈哈");

    for (let i = 0; i < newLines.length; i++) {
      /** 第一行不需要换行 */
      if (i) {
        /** 如果新行数比旧行数多，就需要换行符把屏幕撑开 */
        if (i >= oldLines.length) {
          out.push("\n");
          lastLine = "";
        } else {
          out.push(EConsole.down);
        }
      }
      /** 完全不一样才操作 */
      if (newLines[i] !== oldLines[i]) {
        /** 如果上一行有长度，说明光标在上一行的结尾 */
        if (lastLine.length) {
          this.toLineStart(lastLine, out);
          out.push(EConsole.cleanLineAfter);
        }
        lastLine = newLines[i];
        out.push(newLines[i]);
      } else if (i === newLines.length - 1) {
        /** 最后一行完全相同的时候，光标依然停留在“上一个不相同的行”的结尾，所以需要调整 */
        this.toLineStart(newLines[i], out, EConsole.right);
        this.toLineStart(lastLine, out);
      }
    }

    this.optimizeAndPrint(out);
    this.lastWriteLines = newLines;
  }
  /** 优化并输出 */
  private optimizeAndPrint(out: Array<EConsole | string>) {
    let outputString = "";
    /** 控制方向的 */
    const temp: { up: number; left: number } = { up: 0, left: 0 };
    /** 翻译temp */
    const implement = () => {
      if (temp.left) {
        outputString += temp.left > 0 ? Console.left(temp.left) : Console.right(-temp.left);
        temp.left = 0;
      }
      if (temp.up) {
        outputString += temp.up > 0 ? Console.up(temp.up) : Console.down(-temp.up);
        temp.up = 0;
      }
    };
    for (const str of out) {
      switch (str) {
        case EConsole.left:
          temp.left++;
          break;
        case EConsole.right:
          temp.left--;
          break;
        case EConsole.up:
          temp.up++;
          break;
        case EConsole.down:
          temp.up--;
          break;
        case "\n":
          temp.left = 0;
        default:
          implement();
          outputString += str;
          break;
      }
    }
    implement();
    // logs.push(
    //   outputString
    //     .replace(
    //       /\x1b\[(\d+)([ABCD])/g,
    //       (_, count, type) => "【" + ({ A: "↑", B: "↓", C: "→", D: "←" }[type] + count + "】")
    //     )
    //     .replace(/\x1b\[([A-Za-z])/g, (_, type) => "【" + type + "】")
    // );
    process.stdout.write(outputString);
  }
  /** 光标移到行首 */
  private toLineStart(lineData: string, out: Array<EConsole | string>, sign = EConsole.left) {
    const len = Console.getStringPrintLen(lineData);
    for (let i = 0; i < len; i++) out.push(sign);
    // return Console.left(Console.getStringPrintLen(lineData));
  }
  /** 获取单字符占用的长度 */
  static getCharPrintLen(str: string, index: number) {
    const codePoint = str.codePointAt(index);
    if (codePoint) return codePoint > 256 ? 2 : 1;
    return 0;
  }
  /** 可打印字符的长度 */
  static getStringPrintLen(str: string) {
    let len = 0;
    for (let index = 0; index < str.length; index++) {
      len += Console.getCharPrintLen(str, index);
    }
    return len;
  }
  static up(lineCount = 1) {
    return `\x1b[${lineCount}A`;
  }
  static down(lineCount = 1) {
    return `\x1b[${lineCount}B`;
  }
  static right(charCount = 1) {
    return `\x1b[${charCount}C`;
  }
  static left(charCount = 1) {
    return `\x1b[${charCount}D`;
  }
}

// 测试用例
// const con = new Console();
// let p = 100;
// con.write(`正在下载\nXXX文件`);
// const timer = setInterval(() => {
//   if (p-- < 96) {
//     clearInterval(timer);
//     // console.log(logs);
//     return;
//   }
//   con.write(`正在下载\nXXX文件\n当前进度${p}%${p > 97 ? "\n请耐心等候\n正在连接" : ""}`);
// }, 1000);
