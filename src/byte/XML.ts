/**
 * XML.ts - XML解析工具
 *
 * 本文件实现了一个轻量级的XML解析器，可以将XML文本解析为JavaScript对象。
 * 支持基本的XML语法，包括标签、属性、自闭合标签、CDATA等特性。
 */

/**
 * XML解析后的简化对象类型
 * 键为标签名，值可以是字符串或嵌套的对象
 */
export type XMLParseTerseType = { [x: string]: XMLParseTerseType | string };

/**
 * 原始解析结果的接口定义
 * 包含XML节点的基本信息
 */
export type IParseRaw = {
  path: string[]; // 节点路径，表示节点在XML树中的位置
  tagName: string; // 标签名
  attributes: { [x: string]: string }; // 属性集合
  hasChildren: boolean; // 是否有子节点
  contentRaw: string; // 原始内容文本
};

/**
 * 扩展的节点类型，在IParseRaw基础上增加了子节点和处理后的内容
 */
type IType = IParseRaw & {
  children: IType[]; // 子节点列表
  content: string; // 处理后的内容文本
};

/**
 * XML解析工具对象
 */
export const XML = {
  /**
   * 解析XML文本为原始结构数组
   * 这是解析的核心方法，将XML文本解析为一个扁平的节点数组
   * @param txt XML文本
   * @returns 解析后的节点数组
   */
  parseRaw(txt: string) {
    txt = txt.trim();
    // 创建正则表达式，用于匹配标签名，需要转义特殊字符
    const getTagNameRegExp = (tag: string) => tag.replace(/[^a-z\d]/gi, ch => "\\" + ch);
    // 标签栈，用于跟踪当前解析的路径
    const stack: string[] = [];
    // 输出结果数组
    const out: IParseRaw[] = [];

    // 处理XML声明
    if (txt.substring(0, 5) === `<?xml`) {
      txt = txt.substring(txt.indexOf("?>", 5) + 2);
    }

    /**
     * 匹配函数，用于从文本中匹配正则表达式并更新文本
     * @param reg 正则表达式
     * @param autoSubstrLen 自动截取的额外长度
     * @returns 匹配结果数组或null
     */
    const match = (reg: RegExp, autoSubstrLen = 0) => {
      const regResult = txt.match(reg);
      if (!regResult) {
        return null;
      }
      const [input, ...result] = regResult;
      txt = txt.substring(input.length + autoSubstrLen);
      return result;
    };

    // 主解析循环
    while (txt) {
      /** 获取开始标签 */
      const tagName = (match(/^\s*<([^\!\"\#\$\%\&\'\(\)\*\+\,\/\;\<\=\>\?\@\[\\\]\^\`\{\|\}\~\s]+)/) || [])[0];
      if (!tagName) {
        console.log("----------");
        console.log(stack, txt.substring(0, 100));
        throw new Error("没开始标签？");
        break;
      }
      stack.push(tagName);

      /** 获取属性 */
      let attribute: string[] | null;
      const attributes = {};
      // 循环解析属性，格式为 name="value" 或 name='value'
      while ((attribute = match(/^\s*([^=\s]+?)=("[^"]*?"|'[^']*?')\s*/))) {
        Object.defineProperty(attributes, attribute[0], {
          value: attribute[1].substring(1, attribute[1].length - 1),
          enumerable: true,
        });
      }

      /** 处理自闭合标签 */
      if (match(/^\s*\/\>/)) {
        out.push({
          path: [...stack],
          tagName,
          attributes,
          hasChildren: false,
          contentRaw: "",
        });
        stack.pop();
      } else {
        /** 非自闭合标签处理 */
        if (txt[0] !== ">") {
          throw new Error("非自闭合应该满足条件");
        }
        txt = txt.substring(1);

        /** 处理CDATA内容 */
        if (match(/^\s*\<\!\[CDATA\[/)) {
          let content = "";
          while (1) {
            let end_CDATA = txt.indexOf("]]>");
            if (end_CDATA < 0) {
              throw new Error("no CDATA end");
            }
            /**
             * 判断CDATA里有没有"]]>"字符
             * 如果有，且是特殊标志"]]]><![CDATA["，则替换成"]"
             * 这是处理CDATA嵌套的特殊情况
             */
            if (txt.substring(end_CDATA - 1, end_CDATA + 12) !== "]]]><![CDATA[") {
              content += txt.substring(0, end_CDATA);
              txt = txt.substring(end_CDATA + 3);
              break;
            }
            content += txt.substring(0, end_CDATA) + "]";
            txt = txt.substring(end_CDATA + 12);
          }
          // 检查CDATA后是否有正确的结束标签
          if (!match(new RegExp(`^<\\/${getTagNameRegExp(tagName)}>\\s*`))) {
            throw new Error("CDATA 没有结束标签？？？");
          }
          out.push({
            path: [...stack],
            tagName,
            attributes,
            hasChildren: false,
            contentRaw: content,
          });
          stack.pop();
        } else {
          /** 处理普通内容（非CDATA） */
          const data = match(new RegExp(`^([^\\<]*?)\\<\\/${getTagNameRegExp(tagName)}>\\s*`));
          if (data) {
            // console.log(tagName, data);
            out.push({
              path: [...stack],
              tagName,
              attributes,
              hasChildren: false,
              contentRaw: data[0],
            });
            stack.pop();
          } else {
            /** 有子标签的情况 */
            out.push({
              path: [...stack],
              tagName,
              attributes,
              hasChildren: true,
              contentRaw: "",
            });
            continue;
          }
        }
      }

      /** 尝试删除栈中的结束标签 */
      while (stack.length) {
        if (match(new RegExp(`^\\s*<\\/${getTagNameRegExp(stack[stack.length - 1])}>\\s*`))) {
          stack.pop();
        } else {
          break;
        }
      }
    }

    // 检查解析是否完成
    if (stack.length || txt) {
      throw new Error("解析失败：XML格式不正确");
    }
    return out;
  },

  /**
   * 将XML文本解析为树形结构
   * 返回一个包含完整节点信息的树
   * @param text XML文本
   * @returns 树形结构的根节点
   */
  parseArray(text: string) {
    // 创建根节点
    const out: IType = {
      path: [],
      tagName: "",
      attributes: {},
      children: [],
      contentRaw: "",
      content: "",
      hasChildren: true,
    };
    // 节点栈，用于构建树形结构
    const stack: IType[] = [out];
    // 获取原始解析结果
    const raw = this.parseRaw(text);
    let obj: IParseRaw;

    // 遍历原始节点，构建树形结构
    while ((obj = raw.splice(0, 1)[0])) {
      // 创建新节点，处理内容并初始化子节点数组
      const newObj = { ...obj, content: this.contentToString(obj.contentRaw), children: [] };
      // 将新节点添加到父节点的children中
      stack[obj.path.length - 1].children.push(newObj);
      // 调整栈的长度，确保栈顶是当前节点的父节点
      stack.length = obj.path.length;
      // 如果节点有子节点，将其加入栈中
      if (obj.hasChildren) {
        stack[stack.length] = newObj;
      }
    }
    // 返回根节点的第一个子节点（实际的XML根节点）
    return out.children[0];
  },

  /**
   * 将XML文本解析为JavaScript对象
   * 支持自定义数组判断逻辑
   * @param text XML文本
   * @param isArray 可选，判断节点是否应该解析为数组的函数
   * @returns 解析后的JavaScript对象
   */
  parse(text: string, isArray?: (parseRaw: IParseRaw) => boolean) {
    type IOutput = { [x: string]: IOutput } | Array<IOutput> | string;
    // 创建输出对象
    const out: IOutput = {};
    // 对象栈，用于构建嵌套结构
    const stack: IOutput[] = [out];
    // 获取原始解析结果
    const raw = this.parseRaw(text);

    /**
     * 递归处理节点函数
     * @param deep 当前深度
     * @param length 期望的路径长度
     */
    const fn = (deep: number, length: number) => {
      // 检查是否还有节点，以及路径长度是否匹配
      if (!raw[0] || raw[0].path?.length !== length) {
        return;
      }
      // 取出当前节点
      const obj = raw.splice(0, 1)[0];
      // 获取当前深度的对象
      const pen = stack[deep];

      if (obj.hasChildren) {
        // 判断是否应该解析为数组
        if (Array.isArray(pen[obj.tagName]) || (isArray && isArray(obj))) {
          /** 新建新数组 */
          stack[deep + 1] = pen[obj.tagName] = pen[obj.tagName] || [];

          /** 往老数组追加新元素 */
          pen[obj.tagName].push((stack[deep + 2] = {}));

          /** 因为数组独占一个stack位置，数组的元素也要占一个stack位置 */
          fn(deep + 2, length + 1);
        } else {
          /** 普通obj对象 */
          pen[obj.tagName] = stack[deep + 1] = {};
          fn(deep + 1, length + 1);
        }
      } else {
        // 没有子节点，直接设置内容
        pen[obj.tagName] = this.contentToString(obj.contentRaw);
      }

      // 继续处理同级节点
      fn(deep, length);
    };

    // 开始处理，从深度0和路径长度1开始
    fn(0, 1);
    return out;
  },

  /** 预定义的XML实体映射 */
  predefinedEntities: {
    quot: `"`, // 引号
    amp: `&`, // 与符号
    apos: `'`, // 单引号
    lt: `<`, // 小于号
    gt: `>`, // 大于号
  },

  /**
   * 将XML内容中的实体引用转换为实际字符
   * 处理预定义实体和十六进制字符引用
   * @param text 包含实体引用的文本
   * @returns 转换后的文本
   */
  contentToString(text: string) {
    return text.replace(
      /\&([^;]+)\;/g,
      (_, letter) => this.predefinedEntities[letter] || String.fromCharCode(parseInt(letter.substring(2), 16)),
    );
  },
};

// 测试代码示例（已注释）
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
