export type XMLParseTerseType = { [x: string]: XMLParseTerseType | string };
export const XML = {
  // parseTerse2: (text: string): XMLParseTerseType => {
  //   const stack: string[] = [];
  //   const stackPosition: number[] = [];
  //   const obj = {};
  //   // const arr: [string, string][] = [];
  //   let position = 0;
  //   // tslint:disable-next-line: no-conditional-assignment
  //   while ((position = text.indexOf("<", position)) !== -1) {
  //     const positionEnd = text.indexOf(">", position);
  //     if (positionEnd < 0) {
  //       throw new SyntaxError(`Unexpected end of XML input`);
  //     }
  //     const isEndTab = text[position + 1] === "/";
  //     let tabName = text.substring(position + Number(isEndTab) + 1, positionEnd);
  //     if (tabName.indexOf("![CDATA[") === 0) {
  //       position = text.indexOf("]]") + 2;
  //       continue;
  //     }
  //     const tabNameEnd = tabName.indexOf(" ");
  //     if (tabNameEnd >= 0) {
  //       tabName = tabName.substring(0, tabNameEnd);
  //     }
  //     if (isEndTab) {
  //       // const path = stack.join("/");
  //       const startTab = stack.pop();
  //       if (tabName !== startTab) {
  //         throw new SyntaxError(`tab name not match! start tab: ${startTab}, end tab:${tabName}`);
  //       }
  //       const value = text.substring((stackPosition.pop() ?? 0) + 1, position);
  //       const nowObj = stack.reduce((previousValue, currentValue) => {
  //         if (!(currentValue in previousValue)) {
  //           previousValue[currentValue] = {};
  //         }
  //         return previousValue[currentValue];
  //       }, obj);
  //       if (!(tabName in nowObj)) {
  //         nowObj[tabName] = value.indexOf("<![CDATA[") === 0 ? value.substring(9, value.length - 3) : value;
  //         //   arr.push([path, text.substring(value, position)]);
  //       }
  //     } else {
  //       stack.push(tabName);
  //       stackPosition.push(positionEnd);
  //     }
  //     position = positionEnd;
  //   }
  //   if (stack.length !== 0) {
  //     throw new SyntaxError(`Unexpected end of XML input`);
  //   }
  //   // console.log(arr, obj.xml);
  //   return obj;
  // },
  parseTerse(text: string, position: number = 0) {
    const getTab = () => {
      let positionStart = text.indexOf("<", position);
      if (positionStart === -1) {
        return null;
      }
      const positionEnd = text.indexOf(">", positionStart);
      if (positionEnd < 0) {
        throw new SyntaxError(`Unexpected end of XML input`);
      }
      const tabName = text.substring(positionStart + 1, positionEnd);
      if (tabName.indexOf("![CDATA[") === 0) {
        position = text.indexOf("]]>", position) + 3;
        return getTab();
      }
      position = positionEnd + 1;
      return tabName;
    };
    const fn = (subobj: XMLParseTerseType): XMLParseTerseType => {
      let tabName: string | null;
      while ((tabName = getTab())) {
        if (tabName[0] === "/") {
          break;
        }
        const positionData = position;
        const tabNameEnd = tabName.indexOf(" ");
        if (tabNameEnd >= 0) {
          tabName = tabName.substring(0, tabNameEnd);
        }
        tabName = tabName.trim();
        subobj[tabName] = fn({});
        if (Object.keys(subobj[tabName] || {}).length === 0) {
          const value = text.substring(positionData, position - tabName.length - 3);
          subobj[tabName] = value.indexOf("<![CDATA[") === 0 ? value.substring(9, value.length - 3) : value;
        }
      }
      return subobj;
    };
    return fn({});
  },
};
