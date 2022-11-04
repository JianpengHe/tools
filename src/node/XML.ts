export type XMLParseTerseType = { [x: string]: XMLParseTerseType | string };
export type IParseRaw = {
  path: string[];
  tagName: string;
  attributes: { [x: string]: string };
  hasChildren: boolean;
  content: string;
};
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
      const positionStart = text.indexOf("<", position);
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
        if (Object.keys(subobj[tabName]).length === 0) {
          const value = text.substring(positionData, position - tabName.length - 3);
          subobj[tabName] = value.indexOf("<![CDATA[") === 0 ? value.substring(9, value.length - 3) : value;
        }
      }
      return subobj;
    };
    return fn({});
  },
  parseRaw(txt: string) {
    txt = txt.trim();
    const getTagNameRegExp = (tag: string) => tag.replace(/[^a-z\d]/gi, ch => "\\" + ch);
    const stack: string[] = [];
    const out: IParseRaw[] = [];
    if (txt.substring(0, 5) === `<?xml`) {
      txt = txt.substring(txt.indexOf("?>", 5) + 2);
    }
    const match = (reg: RegExp, autoSubstrLen = 0) => {
      const regResult = txt.match(reg);
      if (!regResult) {
        return null;
      }
      const [input, ...result] = regResult;
      txt = txt.substring(input.length + autoSubstrLen);
      return result;
    };

    while (txt) {
      /** 获取开始标签 */
      const tagName = (match(/^\s*<([^\!\"\#\$\%\&\'\(\)\*\+\,\/\;\<\=\>\?\@\[\\\]\^\`\{\|\}\~\s]+)/) || [])[0];
      if (!tagName) {
        console.log("----------");
        console.log(stack, txt);
        throw new Error("没开始标签？");
        break;
      }
      stack.push(tagName);

      /** 获取属性 */
      let attribute: string[] | null;
      const attributes = {};
      while ((attribute = match(/^\s*([^=\s]+?)=("[^"]*?"|'[^']*?')\s*/))) {
        Object.defineProperty(attributes, attribute[0], {
          value: attribute[1].substring(1, attribute[1].length - 1),
          enumerable: true,
        });
      }

      /** 自闭合 */
      if (match(/^\s*\/\>/)) {
        out.push({
          path: [...stack],
          tagName,
          attributes,
          hasChildren: false,
          content: "",
        });
        stack.pop();
      } else {
        /** 非自闭合应该满足条件 */
        if (txt[0] !== ">") {
          throw new Error("非自闭合应该满足条件");
        }
        txt = txt.substring(1);
        /** 判断<![CDATA[内容 */
        if (match(/^\s*\<\!\[CDATA\[/)) {
          let content = "";
          while (1) {
            let end_CDATA = txt.indexOf("]]>");
            if (end_CDATA < 0) {
              throw new Error("no CDATA end");
            }
            /** 判断CDATA里有没有“]]>”字符，有的话要判断是不是特殊标志“]]]><![CDATA[”，若是则替换成“]” */
            if (txt.substring(end_CDATA - 1, end_CDATA + 12) !== "]]]><![CDATA[") {
              content += txt.substring(0, end_CDATA);
              txt = txt.substring(end_CDATA + 3);
              break;
            }
            content += txt.substring(0, end_CDATA) + "]";
            txt = txt.substring(end_CDATA + 12);
          }
          if (!match(new RegExp(`^<\\/${getTagNameRegExp(tagName)}>\\s*`))) {
            throw new Error("CDATA 没有结束标签？？？");
          }
          out.push({
            path: [...stack],
            tagName,
            attributes,
            hasChildren: false,
            content,
          });
          stack.pop();
        } else {
          /** 判断普通内容（非CDATA的content） */
          const data = match(new RegExp(`^([^\\<]*?)\\<\\/${getTagNameRegExp(tagName)}>\\s*`));
          if (data) {
            // console.log(tagName, data);
            out.push({
              path: [...stack],
              tagName,
              attributes,
              hasChildren: false,
              content: data[0],
            });
            stack.pop();
          } else {
            /** 有子标签的情况 */
            out.push({
              path: [...stack],
              tagName,
              attributes,
              hasChildren: true,
              content: "",
            });
            continue;
          }
        }
      }
      /** 尝试删除栈中的结束标签 */
      while (stack.length) {
        if (match(new RegExp(`^<\\/${getTagNameRegExp(stack[stack.length - 1])}>\\s*`))) {
          stack.pop();
        } else {
          break;
        }
      }
    }
    // console.log(out, stack, txt);
    if (stack.length || txt) {
      throw new Error("失败");
    }
    return out;
  },
  parse(text: string, isArray?: (parseRaw: IParseRaw) => boolean) {
    type IOutput = { [x: string]: IOutput } | Array<IOutput> | string;
    const out: IOutput = {};
    const stack: IOutput[] = [out];
    const raw = this.parseRaw(text);
    const fn = (deep: number, length: number) => {
      if (!raw[0] || raw[0].path?.length !== length) {
        return;
      }
      const obj = raw.splice(0, 1)[0];
      const pen = stack[deep];
      if (obj.hasChildren) {
        if (Array.isArray(pen[obj.tagName]) || (isArray && isArray(obj))) {
          /** 新建新数组 */
          stack[deep + 1] = pen[obj.tagName] = pen[obj.tagName] || [];

          /** 往老数组追加 */
          pen[obj.tagName].push((stack[deep + 2] = {}));

          /** 因为数组独占一个stack位置，数组的元素也要占一个stack位置 */
          fn(deep + 2, length + 1);
        } else {
          /** 普通obj对象 */
          pen[obj.tagName] = stack[deep + 1] = {};
          fn(deep + 1, length + 1);
        }
      } else {
        pen[obj.tagName] = this.contentToString(obj.content);
      }

      fn(deep, length);
    };
    fn(0, 1);
    return out;
  },
  /** 预定义实体 */
  predefinedEntities: {
    quot: `"`,
    amp: `&`,
    apos: `'`,
    lt: `<`,
    gt: `>`,
  },
  contentToString(text: string) {
    return text.replace(
      /\&([^;]+)\;/g,
      (_, letter) => this.predefinedEntities[letter] || String.fromCharCode(parseInt(letter.substring(2), 16))
    );
  },
};

// const test = `

// <?xml version='1.0' encoding='utf-8' ?>      <ListBucketResult>
// <Name>examplebucket-1250000000</Name><T>
//       <Prefix name="gg" /></T>
//       <哈哈哈哈/>
//       <Max-Keys age='4' et="f'll">1000</Max-Keys>
//       <IsTruncated>false</IsTruncated>
//       <Contents>
//           <Key>&#x410;&#x41;.jpg</Key>
//           <Owner>
//                     <ID>1250000000</ID><DisplayName>de1250000000</DisplayName>
//           </Owner>
//           <StorageClass><![CDATA[This text contains a CEND ]]]><![CDATA[]>66CEND ]]]><![CDATA[]>666]]></StorageClass>
//       </Contents>
//       <Contents  obj="gg">
//           <Key>example-folder-1/example-object-2.jpg</Key>
//           <LastModified>2020-12-10T03:37:30.000Z</LastModified>
//           <E.Tag>&quot;c9d28698978bb6fef6c1ed1c439a17d3&quot;</E.Tag>
//           <Size>37</Size>
//           <Owner>
//                     <ID>1250000000</ID>
//                     <DisplayName></DisplayName>
//           </Owner>
//                 <StorageClass><![CDATA[INTELLIGENT</StorageClass>TIER
//                 ING]]></StorageClass>
//                 <StorageTier>FREQUENT</StorageTier>
//       </Contents>
// </ListBucketResult>

// `;
// console.log("// 验证\nconsole.dir(new DOMParser().parseFromString(`" + test.trim() + '`,"text/xml").firstChild)');

// console.log(
//   XML.parse(test, a => {
//     console.log(a.path.join("/"));
//     return a.path.join("/") === "ListBucketResult/Contents";
//   }).ListBucketResult
// );
