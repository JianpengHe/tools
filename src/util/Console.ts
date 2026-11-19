export enum EConsole {
  up,
  down,
  right,
  left,
  cleanLineAfter = "\x1b[K",
}

export enum EConsoleStyle {
  none = 0,
  /** 加粗（高亮度） */
  Bold = 1,
  Faint = 2,
  Italic = 3,
  Underline = 4,
  SlowBlink = 5,
  RapidBlink = 6,
  Conceal = 8,
  CrossedOut = 9,

  black = 30,
  red = 31,
  green = 32,
  yellow = 33,
  blue = 34,
  purple = 35,
  cyan = 36,
  white = 37,

  blackBackground = 40,
  redBackground = 41,
  greenBackground = 42,
  yellowBackground = 43,
  blueBackground = 44,
  purpleBackground = 45,
  cyanBackground = 46,
  whiteBackground = 47,
}

// const logs: string[] = [];
export class Console {
  public lastWriteLines: string[] = [];
  public write(str: string) {
    const newLines = str.split("\n");
    if (newLines.length > process.stdout.rows - 1) newLines.splice(0, newLines.length - process.stdout.rows + 1);
    const oldLines = this.lastWriteLines;
    // logs.push(oldLines.join("\n") + "------------>" + newLines.join("\n"));
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
      let newLine = newLines[i];
      const maxChar = process.stdout.columns || 80;
      if (Console.getStringPrintLen(newLine) >= maxChar) {
        const strArr = newLine.match(/./gu) || [];
        newLine = "";
        do {
          let curChar = strArr.shift();
          if (curChar === undefined) break;
          newLine += curChar;
          /** 控制字符是一个整体，不能拆开 */
          if (curChar === "\x1b") {
            do {
              curChar = strArr.shift();
              if (curChar === undefined) break;
              newLine += curChar;
            } while (/[^a-z]/i.test(curChar));
          }
        } while (Console.getStringPrintLen(newLine) < maxChar - 4 && strArr.length);
        newLine += Console.setColor(EConsoleStyle.none) + "...";
      }
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
      if (newLine !== oldLines[i]) {
        /** 如果上一行有长度，说明光标在上一行的结尾 */
        if (lastLine.length) {
          this.toLineStart(lastLine, out);
          //   out.push(EConsole.cleanLineAfter);
        }
        this.updateLine(oldLines[i], newLine, out);
        lastLine = newLine;
        // out.push(newLines[i]);
      } else if (i === newLines.length - 1) {
        /** 最后一行完全相同的时候，光标依然停留在“上一个不相同的行”的结尾，所以需要调整 */
        this.toLineStart(newLine, out, EConsole.right);
        this.toLineStart(lastLine, out);
      }
    }

    this.optimizeAndPrint(out);
    this.lastWriteLines = newLines;
    return this;
  }
  public reset() {
    this.lastWriteLines.length = 0;
    return this;
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

  /** 更新一行，请将光标移到本行开头再调本函数 */
  private updateLine(oldLine: string | undefined, newLine: string, out: Array<EConsole | string>) {
    if (newLine.includes("\x1b")) {
      out.push(EConsole.cleanLineAfter);
      oldLine = undefined;
    }
    if (oldLine === undefined) {
      out.push(newLine);
      return;
    }
    /** 按显示所占的位置展开字符串 */
    const buildSplit = (str: string) => {
      const out: string[] = [];
      for (let i = 0; i < str.length; i++) {
        /** 当前字符占用的宽度（全角/半角） */
        const charLen = Console.getCharPrintLen(str, i);
        for (let n = 0; n < charLen; n++) out.push(n ? str[i] + n : str[i]);
      }
      return out;
    };
    const oldSplit = buildSplit(oldLine);
    const newSplit = buildSplit(newLine);

    for (let i = 0; i < newSplit.length; i++) {
      if (oldSplit[i] === newSplit[i]) {
        out.push(EConsole.right);
        continue;
      }
      if (newSplit[i].length === 1) out.push(newSplit[i]);
    }

    if (oldLine.length > newLine.length) out.push(EConsole.cleanLineAfter);
  }
  /** 获取单字符占用的长度 */
  static getCharPrintLen(str: string, index: number) {
    const codePoint = str.codePointAt(index);
    if (!codePoint || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
    return codePoint > 256 ? 2 : 1;
  }
  /** 可打印字符的长度 */
  static getStringPrintLen(str: string) {
    return (str.replace(/\x1b[^a-zA-Z]*[a-zA-Z]/g, "").match(/./gu) || []).reduce(
      (total, char) => total + Console.getCharPrintLen(char, 0),
      0,
    );
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

  static setColor(...consoleStyles: EConsoleStyle[]) {
    return `\x1b[${consoleStyles.join(";")}m`;
  }
  static setStringColor(str: string, ...consoleStyles: EConsoleStyle[]) {
    return Console.setColor.apply(this, consoleStyles) + str + Console.setColor(EConsoleStyle.none);
  }

  static getProgressBar(
    /** 取值范围0-1 */
    progress: number,
    width = 20,
    doneConsoleStyles: EConsoleStyle[] = [],
    undoneConsoleStyles: EConsoleStyle[] = [],
  ) {
    const done = Math.round(width * progress);
    return (
      Console.setStringColor("█".repeat(done), EConsoleStyle.green, ...doneConsoleStyles) +
      Console.setStringColor("█".repeat(width - done), EConsoleStyle.white, ...undoneConsoleStyles)
    );
  }

  static showTitle(title: string, paddingChar = "*") {
    title = " " + title + " ";
    const byteLength = Console.getStringPrintLen(title);
    const padding = Math.max(0, (process.stdout.columns - byteLength) / 2);
    console.log(paddingChar.repeat(Math.floor(padding)) + title + paddingChar.repeat(Math.ceil(padding)));
  }
}

// 测试用例
// const con = new Console();
// let p = 100;
// con.write(`正在下载\nXXX文件`);
// const timer = setInterval(() => {
//   if ((p -= 1) < 96) {
//     clearInterval(timer);
//     // console.log(logs);
//     return;
//   }
//   con.write(
//     `正在下载\n${p > 98 ? "XXX" : "这是个很长的\x1b[31m红色红色红色红色红色\x1b[0m\x1b[0m\x1b[0m\x1b[0m\x1b[0m\x1b[0m\x1b[0m\x1b[0m字符串，里面还有换行、\t制表符、\b退格，还有 emoji 🌟💖🌟💖🌟💖".repeat(3)}文件\n\n\n当前进度${Console.setStringColor(
//       String(p),
//       EConsoleStyle.Bold,
//       p > 98 ? EConsoleStyle.yellowBackground : EConsoleStyle.greenBackground,
//       EConsoleStyle.red,
//     )}%\n${p > 97 ? "请耐心、耐心、耐心等候\n正在连接" : ""}`,
//   );
// }, 1000);

// 测试用例2
// const con = new Console();
// let p = 0;
// con.write(`正在下载\nXXX文件\n请耐心等候`);
// const timer = setInterval(() => {
//   if (p++ === 100) {
//     clearInterval(timer);
//     return;
//   }
//   con.write(
//     `正在下载\nXXX文件\n${Console.getProgressBar(p / 100, 20, p > 50 ? [EConsoleStyle.red] : [])} ${p}%\n请耐心等候\n`
//   );
// }, 100);
