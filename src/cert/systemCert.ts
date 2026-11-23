/**
 * systemCert.ts - 操作系统证书信任管理工具
 *
 * 本模块负责将自签名 CA 根证书导入系统证书库中，使操作系统、各类浏览器及系统工具信任该 CA 签发的所有服务端证书。
 * 支持 Windows、macOS 以及主流 Linux 发行版的静默安装与自提权机制。
 */

// import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import * as util from "util";

const execFileAsync = util.promisify(childProcess.execFile);

/**
 * 将 CA 根证书安装并信任到 Windows 系统“受信任的根证书颁发机构”证书库中
 *
 * 安装流程与提权设计：
 * 1. 优先调用 Windows 原生 `certutil.exe -addstore -f root <certPath>` 命令；
 *    若当前 Node.js 具备管理员权限，则直接静默安装成功；
 * 2. 若退出码为 0x0005 (ERROR_ACCESS_DENIED / 权限不足)，则通过 PowerShell 启动带有 `-Verb RunAs` 的进程，
 *    弹出 Windows UAC 对话框向用户申请管理员授权；
 * 3. 采用 UTF-16LE + Base64 `-EncodedCommand` 执行 PowerShell 脚本，彻底免疫路径中的空格与引号转义破坏。
 *
 * @param caPath CA 根证书文件路径（支持相对路径与绝对路径）
 * @returns 安装成功返回 true，用户拒绝 UAC 提权或安装失败返回 false
 */
export async function trustCaInWindows(caPath: string): Promise<boolean> {
  const certPath = path.isAbsolute(caPath) ? caPath : path.resolve("./", caPath);
  console.log("尝试在 Windows 安装证书...", certPath);

  // 1. 优先使用 execFile 直接执行（若当前已是管理员则静默成功，无需 cmd.exe 且天然支持空格路径）
  let exitCode = 0;
  try {
    await execFileAsync("certutil.exe", ["-addstore", "-f", "root", certPath]);
    console.log("【成功】证书已静默安装！（当前已具备管理员权限）");
    return true;
  } catch (e: any) {
    exitCode = e.code;
  }
  /** 0x0005 表示权限不足，需要 UAC 提权 */
  if ((exitCode & 0xffff) !== 0x0005) {
    console.log("【失败】无法安装证书", certPath, exitCode);
    return false;
  }

  try {
    // 2. 使用 PowerShell 弹出 UAC 提权窗口
    const psScript = `Start-Process -FilePath 'certutil.exe' -ArgumentList @('-addstore', '-f', 'root', ('\"' + '${certPath.replace(/'/g, "''")}' + '\"')) -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop`;
    const b64 = Buffer.from(psScript, "utf16le").toString("base64");
    await execFileAsync("powershell.exe", ["-NoProfile", "-EncodedCommand", b64]);
    console.log("【成功】UAC 授权通过，证书已成功安装！");
    return true;
  } catch (e: any) {
    console.log("【失败】取消了 UAC 授权，或证书发生错误。", certPath, e.code);
  }
  return false;
}

/**
 * 将 CA 根证书安装并信任到当前操作系统的根证书库中
 *
 * 自动识别 Windows、macOS (Darwin) 和 Linux，分发调用对应平台的证书导入实现
 *
 * @param caPath CA 根证书文件路径
 * @returns 安装成功返回 true，否则返回 false
 */
export async function trustCa(caPath: string): Promise<boolean> {
  switch (process.platform) {
    case "win32":
      return trustCaInWindows(caPath);
    // case "darwin":
    //   return trustCaInMacOS(caPath);
    // case "linux":
    //   return trustCaInLinux(caPath);
    default:
      console.log(`【失败】暂不支持当前操作系统平台: ${process.platform}`);
      return false;
  }
}

// ============================================================================
// 测试用例 / 使用示例: 生成自签 CA 证书并信任导入 Windows 根证书库
// ============================================================================
/**
 * 演示：
 * 1. 动态生成一个临时自签 CA 根证书并存放到当前目录；
 * 2. 调用 trustCaInWindows 安装 CA 根证书：
 *    - 若当前终端具备管理员权限，将进行静默无感知导入；
 *    - 若当前终端为普通用户，将弹出系统 UAC 弹窗向用户请求提权授权；
 * 3. 验证导入结果（可在 Windows 运行 certmgr.msc，在“受信任的根证书颁发机构”中查看）。
 *
 * 如需调试测试，可解除下方对应代码块的注释直接运行。
 */
// (async () => {
//   const fs = await import("fs");
//   const { CertGenerator } = await import("./CertGenerator");
//
//   console.log("=== 测试 Windows 证书信任与 UAC 提权安装 ===");
//   const testCaName = "Temp Test Root CA";
//   const caCertPath = path.resolve("./temp-test-ca.crt");
//
//   // 若测试证书不存在，先动态生成一个测试用 CA
//   if (!fs.existsSync(caCertPath)) {
//     console.log(`⏳ 正在自动生成测试 CA 证书: ${testCaName}...`);
//     const { caCertPem } = await CertGenerator.createRootCA(testCaName);
//     await fs.promises.writeFile(caCertPath, caCertPem);
//   }
//
//   console.log("⏳ 正在尝试将 CA 证书导入 Windows 受信任根证书库:", caCertPath);
//   const success = await trustCaInWindows(caCertPath);
//   if (success) {
//     console.log("🎉 根证书已成功导入系统信任区！");
//     console.log("💡 验证提示: 可按下 Win + R，输入 certmgr.msc 打开证书管理器，在【受信任的根证书颁发机构 -> 证书】列表中查看该证书。");
//   } else {
//     console.log("⚠️ 根证书导入未完成（用户在弹出的 UAC 窗口中点击了取消，或执行失败）。");
//   }
// })();
