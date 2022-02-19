export type XMLParseTerseType = { [x: string]: XMLParseTerseType | string };
export const XML = {
  parseTerse: (text: string): XMLParseTerseType => {
    const stack: string[] = [];
    const stackPosition: number[] = [];
    const obj = {};
    // const arr: [string, string][] = [];
    let position = 0;
    // tslint:disable-next-line: no-conditional-assignment
    while ((position = text.indexOf("<", position)) !== -1) {
      //   if (text.substring(position) === "!") {
      //     position += 2;
      //     continue;
      //   }
      const positionEnd = text.indexOf(">", position);
      if (positionEnd < 0) {
        throw new SyntaxError(`Unexpected end of XML input`);
      }
      const isEndTab = text[position + 1] === "/";
      let tabName = text.substring(position + Number(isEndTab) + 1, positionEnd);
      if (tabName.indexOf("![CDATA[") === 0) {
        position = text.indexOf("]]") + 2;
        continue;
      }
      const tabNameEnd = tabName.indexOf(" ");
      if (tabNameEnd >= 0) {
        tabName = tabName.substring(0, tabNameEnd);
      }
      if (isEndTab) {
        // const path = stack.join("/");
        const startTab = stack.pop();
        if (tabName !== startTab) {
          throw new SyntaxError(`tab name not match! start tab: ${startTab}, end tab:${tabName}`);
        }
        const value = text.substring((stackPosition.pop() ?? 0) + 1, position);
        const nowObj = stack.reduce((previousValue, currentValue) => {
          if (!(currentValue in previousValue)) {
            previousValue[currentValue] = {};
          }
          return previousValue[currentValue];
        }, obj);
        if (!(tabName in nowObj)) {
          nowObj[tabName] = value.indexOf("<![CDATA[") === 0 ? value.substring(9, value.length - 3) : value;
          //   arr.push([path, text.substring(value, position)]);
        }
      } else {
        stack.push(tabName);
        stackPosition.push(positionEnd);
      }
      position = positionEnd;
    }
    if (stack.length !== 0) {
      throw new SyntaxError(`Unexpected end of XML input`);
    }
    // console.log(arr, obj.xml);
    return obj;
  },
};
