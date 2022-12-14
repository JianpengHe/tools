"use strict";
const fs = require("fs");
const child_process = require("child_process");
const PATH = "release";
(async () => {
  console.log("正在清空文件夹", PATH);
  await fs.promises.rm(PATH, { force: true, recursive: true });
  await new Promise(r => setTimeout(() => r(), 1000));
  await fs.promises.mkdir(PATH);

  const fileMap = new Map();
  const relyMap = new Map();
  const readFile = async path => {
    for (const file of await fs.promises.readdir("src" + path, { withFileTypes: true })) {
      if (file.isDirectory()) {
        await fs.promises.mkdir(PATH + path + "/" + file.name);
        await readFile(path + "/" + file.name);
        continue;
      }
      
      if (!/\.ts$/.test(file.name)) {
        continue;
      }

      relyMap.set(path + "/" + file.name, new Set());
      fileMap.set(path + "/" + file.name, {
        name: path + "/" + file.name,
        path,
        fileData: String(await fs.promises.readFile("src" + path + "/" + file.name))
          .split("\n")
          .map(str => (/^\/\//.test(str.trim()) ? "" : str)),
        rely: [],
        sysRely: [],
        complete: [],
      });
    }
  };
  await readFile("");
  for (const [_, obj] of fileMap) {
    const { name, fileData, rely, sysRely, path } = obj;
    fileData.forEach((line, index) => {
      const reg = line
        .replace(/'/g, '"')
        .replace(";", "")
        .trim()
        .match(/^import .*? from "([^"]+)"$/);
      if (reg && reg[1]) {
        const mod = reg[1];
        if (/^\.\//.test(mod)) {
          rely[index] = path + "/" + mod.substring(2) + ".ts";
        } else {
          sysRely.push(mod);
          rely[index] = null;
        }
      }
    });
    [...new Set(rely.filter(a => a))].forEach(otherName => {
      (relyMap.get(name) || new Set()).add(otherName);
    });
  }
  // console.log(fileMap);

  const sysRely = new Set();
  const order = [];
  const used = new Set();
  let deep = 0;
  let deepMask = [];
  const readRely = (fileName, index = -1, array = []) => {
    const child = [...relyMap.get(fileName)];
    const output =
      deepMask
        .slice(0, deep)
        .map(mask => (mask ? "  " : "┃ "))
        .join("") + `${array.length === index + 1 ? "┗" : "┣"}━${child.length ? "┳" : "━"}━   `;
    if (array.length === index + 1) {
      deepMask[deep] = 1;
    }
    if (child.length) {
      deepMask[deep + 1] = 0;
    }
    if (used.has(fileName)) {
      console.log(`${output}\x1B[31m${fileName}\x1B[0m`);
      throw new Error("循环引用");
    }
    fileMap.get(fileName)?.sysRely?.forEach(a => sysRely.add(a));
    console.log(`${output}\x1B[${order.includes(fileName) ? 32 : 0}m${fileName}\x1B[0m`);
    order.unshift(fileName);
    used.add(fileName);
    deep++;
    child.forEach(readRely);
    used.delete(fileName);
    deep--;
  };

  const pack = (fileName, recursion) => {
    const obj = fileMap.get(fileName);
    // if (obj.fileData.length && obj.complete.length) {
    //   return;
    // }
    console.log("正在打包", fileName, "\n▼");
    readRely(fileName);
    obj.sysRely = [...sysRely].sort();
    sysRely.clear();
    obj.order = [...new Set(order)].filter(name => name !== fileName);
    order.length = 0;
    if (recursion === true) {
      obj.order.forEach(pack);
    }
    obj.complete = obj.fileData.filter((line, index) => obj.rely[index] === undefined);
    // obj.complete = obj.fileData.map((line, index) => {
    //   if (obj.rely[index] === null) {
    //     return "";
    //     // return "// " + line;
    //   }
    //   if (obj.rely[index]) {
    //     if (recursion === true) {
    //       return `// <${obj.rely[index]}>\n${fileMap.get(obj.rely[index]).complete.join("\n")}\n// <${
    //         obj.rely[index]
    //       } END>\n`;
    //     }
    //     return `// <忽略${obj.rely[index]}>\n`;
    //   }
    //   return line;
    // });
  };
  for (const [name, obj] of fileMap) {
    pack(name, true);
    await fs.promises.writeFile(
      PATH + name,
      [
        ...obj.sysRely.map(mod => `import * as ${mod} from "${mod}";`),
        "",
        ...obj.order.map(
          otherName =>
            `// <${otherName}>\n${fileMap.get(otherName).complete.join("\n").trim()}\n// <${otherName} END>\n`
        ),
        "",
        ...obj.complete,
      ].join("\n")
    );
  }

  let tsconfig = String(await fs.promises.readFile("tsconfig.json"));
  while (1) {
    const i = tsconfig.indexOf("//");
    if (i < 0) {
      break;
    }
    const i2 = tsconfig.indexOf("\n", i);
    if (i2 < 0) {
      tsconfig = tsconfig.substring(0, i);
    } else {
      tsconfig = tsconfig.substring(0, i) + tsconfig.substring(i2);
    }
  }
  tsconfig = JSON.parse(tsconfig);
  tsconfig.compilerOptions = tsconfig.compilerOptions || {};
  delete tsconfig.compilerOptions.outDir;
  tsconfig.compilerOptions.typeRoots = (tsconfig.compilerOptions.typeRoots || []).map(item =>
    item.replace(/^(\.\/)*node_modules/, "../node_modules")
  );
  tsconfig.exclude = (tsconfig.exclude || []).filter(item => !/^(\.\/)*release/.test(item));
  await fs.promises.writeFile(PATH + "/tsconfig.json", JSON.stringify(tsconfig, null, 2));
  child_process.spawn("tsc", ["-p", "release"], { stdio: "inherit", shell: true });
})();
