/**
 * JWT (JSON Web Token) 实现
 * 可在校验网站 https://jwt.io/ 验证生成的令牌
 * 支持算法：HS256/384/512, ES256/384/512, RS256/384/512, PS256/384/512
 */
import * as crypto from "crypto";

/**
 * JWT 标准载荷类型定义
 * 包含 JWT 标准规范中定义的字段
 */
export type JWTBasePayload = {
  /** exp (Expiration time)：过期时间 */
  exp?: number;
  /** iat (Issued at)：签发时间 */
  iat?: number;
  /** iss (Issuer)：签发人 */
  iss?: string;
  /** sub (Subject)：主题 */
  sub?: string;
  /** jti (JWT ID)：JWT ID */
  jti?: string;
  /** nbf (Not before)：生效时间 */
  nbf?: number;
  /** aud (Audience)：接收者 */
  aud?: string;
};

/**
 * JWS (JSON Web Signature) 类
 * 用于处理 JWT 的签名和验证
 */
export class JWS<T extends Record<string, any>> {
  /**
   * JWT 头部信息
   * alg: 签名算法
   * typ: 令牌类型，通常为 JWT
   */
  public readonly header: {
    alg: string;
    typ?: string;
  };
  /**
   * JWT 载荷数据
   * 包含标准字段和自定义数据
   */
  public readonly payload: JWTBasePayload & T;
  /**
   * JWT 签名数据
   */
  public readonly signature: Buffer;
  /**
   * 原始头部数据（base64url 编码）
   */
  public readonly headerRAW: string;
  /**
   * 原始载荷数据（base64url 编码）
   */
  public readonly payloadRAW: string;
  /**
   * 构造函数，从 JWT 字符串解析
   * @param jwtToken JWT 令牌字符串
   */
  constructor(jwtToken: string) {
    const [headerRaw, payloadRaw, signatureRaw] = jwtToken.split(".");
    this.signature = JWS.base64urlDecode(signatureRaw);
    this.headerRAW = String(headerRaw);
    this.payloadRAW = String(payloadRaw);
    this.header = JSON.parse(String(JWS.base64urlDecode(this.headerRAW)));
    this.payload = JSON.parse(String(JWS.base64urlDecode(this.payloadRAW)));
  }
  /**
   * 验证 JWT 签名
   * @param publicKey 公钥（对称算法为密钥）
   * @param expectedAlg 期望的算法，用于防止算法替换攻击
   * @returns 验证结果，true 表示验证通过
   */
  public verify(publicKey: string, expectedAlg: string) {
    const { exp, iat, nbf } = this.payload;
    const currentTimestamp = Date.now() / 1000;

    // 验证过期时间
    if (exp && exp < currentTimestamp) return false; //throw new Error("JWT已过期");
    // 验证生效时间
    if ((iat && iat > currentTimestamp) || (nbf && nbf > currentTimestamp)) return false; //throw new Error("JWT未生效");

    const signedData: any = `${this.headerRAW}.${this.payloadRAW}`;
    const tokenAlg = String(this.header.alg || "").toUpperCase();

    // 验证算法是否匹配
    if (expectedAlg && expectedAlg !== tokenAlg) return false;

    // 无算法或算法为 none 时不验证签名
    if (!tokenAlg || tokenAlg === "none") return true;

    const hashAlgorithm = "sha" + tokenAlg.substring(2);
    const { signature } = this;

    // 根据不同算法类型验证签名
    if (tokenAlg.startsWith("HS"))
      return signature.equals(crypto.createHmac(hashAlgorithm, publicKey).update(signedData).digest());
    if (tokenAlg.startsWith("ES")) return crypto.verify(hashAlgorithm, signedData, JWS.getESKey(publicKey), signature);
    if (tokenAlg.startsWith("RS")) return crypto.verify(hashAlgorithm, signedData, publicKey, signature);
    if (tokenAlg.startsWith("PS")) return crypto.verify(hashAlgorithm, signedData, JWS.getPSKey(publicKey), signature);

    throw new Error("暂不支持的算法：" + tokenAlg);
  }
  /**
   * 生成 JWT 签名
   * @param payload 载荷数据
   * @param privateKey 私钥（对称算法为密钥）
   * @param expirationTime 过期时间（秒数或日期对象）
   * @param algorithm 签名算法，默认为 HS512
   * @returns JWT 令牌字符串
   */
  static sign<T extends Record<string, any>>(
    payload: JWS<T>["payload"],
    privateKey: string,
    expirationTime?: number | Date,
    algorithm = "HS512"
  ): string {
    // 添加时间相关字段
    if (expirationTime) {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      // 计算过期时间戳
      payload.exp = Math.floor(
        (expirationTime instanceof Date
          ? expirationTime
          : new Date((expirationTime + currentTimestamp) * 1000)
        ).getTime() / 1000
      );
      // 设置签发时间和生效时间
      payload.iat = currentTimestamp;
      payload.nbf = currentTimestamp;
    }

    // 编码头部和载荷
    const headerEncoded = JWS.base64url(Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })));
    const payloadEncoded = JWS.base64url(Buffer.from(JSON.stringify(payload)));
    const dataToSign: any = `${headerEncoded}.${payloadEncoded}`;

    // 无算法或算法为 none 时不生成签名
    if (!algorithm || algorithm === "none") return dataToSign;

    const hashAlgorithm = "sha" + algorithm.substring(2);
    const formatToken = (signature: Buffer) => dataToSign + "." + JWS.base64url(signature);

    // 根据不同算法类型生成签名
    if (algorithm.startsWith("HS"))
      return formatToken(crypto.createHmac(hashAlgorithm, privateKey).update(dataToSign).digest());
    if (algorithm.startsWith("ES"))
      return formatToken(crypto.sign(hashAlgorithm, dataToSign, JWS.getESKey(privateKey)));
    if (algorithm.startsWith("RS")) return formatToken(crypto.sign(hashAlgorithm, dataToSign, privateKey));
    if (algorithm.startsWith("PS"))
      return formatToken(crypto.sign(hashAlgorithm, dataToSign, JWS.getPSKey(privateKey)));

    throw new Error("暂不支持的算法：" + algorithm);
  }

  /**
   * 获取 ECDSA 密钥配置
   * @param key 密钥字符串
   * @returns 密钥配置对象
   */
  static getESKey(key: string): any {
    return {
      key,
      format: "pem",
      dsaEncoding: "ieee-p1363", // 关键：使用 IEEE P1363 格式
    };
  }
  /**
   * 获取 RSA-PSS 密钥配置
   * @param key 密钥字符串
   * @returns 密钥配置对象
   */
  static getPSKey(key: string): any {
    return {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    };
  }

  /**
   * Base64URL 编码
   * 将 Buffer 转换为 Base64URL 格式字符串
   * @param inputBuffer 输入缓冲区
   * @returns Base64URL 编码字符串
   */
  static base64url(inputBuffer: Buffer) {
    return inputBuffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  /**
   * Base64URL 解码
   * 将 Base64URL 格式字符串转换为 Buffer
   * @param encodedString Base64URL 编码字符串
   * @returns 解码后的 Buffer
   */
  static base64urlDecode(encodedString: string) {
    // 替换 Base64URL 特殊字符为标准 Base64 字符
    const standardBase64 = encodedString.replace(/-/g, "+").replace(/_/g, "/");
    // 添加必要的填充字符
    const paddingLength = standardBase64.length % 4 === 0 ? 0 : 4 - (standardBase64.length % 4);
    const paddedString = standardBase64 + "=".repeat(paddingLength);
    return Buffer.from(paddedString, "base64");
  }
}

/** 以下是测试用例 */
// import { Console } from "./Console";
// function testJWS(alg: string, { privateKey, publicKey }: { privateKey: string; publicKey: string }) {
//   Console.showTitle("测试" + alg);
//   console.log(publicKey);
//   console.log(privateKey);
//   Console.showTitle("开始签名");
//   console.time(alg + "耗时");
//   const jwt = JWS.sign({ aud: "PG", userId: 666 }, privateKey, 20 * 60, alg);
//   console.log(jwt);
//   console.log("签名长度：", jwt.length);
//   Console.showTitle("验证签名");
//   const jws = new JWS(jwt);
//   console.log("解析完成：", new JWS(jwt));
//   console.log("校验结果：", jws.verify(publicKey, alg));
//   console.timeEnd(alg + "耗时");
//   Console.showTitle("测试" + alg + " END");
//   console.log("\n\n");
// }
// /** 压力测试 */
// function stressTesting(alg: string, KEY: { privateKey: string; publicKey: string }, times: number) {
//   Console.showTitle(`压力测试${alg} (${times}次)`);
//   console.time(alg + "耗时");
//   for (let i = 0; i < times; i++) {
//     const jws = new JWS(JWS.sign({ aud: "PG" + i, userId: i }, KEY.privateKey, 1000, alg));
//     if (!jws.verify(KEY.publicKey, alg)) throw new Error("签名校验不通过");
//   }
//   console.timeEnd(alg + "耗时");
// }

// /** 生成密钥 */
// const HS256_KEY = {
//   privateKey: "123456",
//   publicKey: "123456",
// };
// const ES256_KEY = crypto.generateKeyPairSync("ec", {
//   namedCurve: "prime256v1",
//   publicKeyEncoding: {
//     type: "spki",
//     format: "pem",
//   },
//   privateKeyEncoding: {
//     type: "pkcs8",
//     format: "pem",
//   },
// });
// const RS256_KEY = crypto.generateKeyPairSync("rsa", {
//   modulusLength: 2048, // 密钥长度，RS256 建议至少 2048 位
//   publicKeyEncoding: {
//     type: "spki", // 公钥标准，适合 JWT 用的 PEM 格式
//     format: "pem",
//   },
//   privateKeyEncoding: {
//     type: "pkcs8", // 私钥标准
//     format: "pem",
//   },
// });
// const PS256_KEY = crypto.generateKeyPairSync("rsa", {
//   modulusLength: 2048, // 密钥长度，RS256 建议至少 2048 位
//   publicKeyEncoding: {
//     type: "spki", // 公钥标准，适合 JWT 用的 PEM 格式
//     format: "pem",
//   },
//   privateKeyEncoding: {
//     type: "pkcs8", // 私钥标准
//     format: "pem",
//   },
// });

/** 测试用例 */
// testJWS("HS256", HS256_KEY);
// testJWS("ES256", ES256_KEY);
// testJWS("RS256", RS256_KEY);
// testJWS("PS256", PS256_KEY);

/** 压力测试 */
// stressTesting("HS256", HS256_KEY, 1000);
// stressTesting("ES256", ES256_KEY, 1000);
// stressTesting("RS256", RS256_KEY, 1000);
// stressTesting("PS256", PS256_KEY, 1000);

/**
 * JWT 封装类
 * 提供简化的 JWT 操作接口，包括生成、解析和验证
 */
export class JWT<T extends Record<string, any> & JWTBasePayload> {
  /**
   * 公钥（对称算法为密钥）
   */
  public readonly publicKey: string;

  /**
   * 私钥（对称算法为密钥）
   */
  public readonly privateKey: string;

  /**
   * 令牌过期时间（秒）
   */
  public readonly expirationTime: number;

  /**
   * 签名算法
   */
  public readonly algorithm: string;
  /**
   * 构造函数
   * @param expirationTime 令牌过期时间（秒）
   * @param algorithm 签名算法，默认为 HS512
   * @param publicKey 公钥（对称算法为密钥），为空时自动生成
   * @param privateKey 私钥（对称算法为密钥），为空时使用公钥
   */
  constructor(
    expirationTime: number,
    algorithm: string = "HS512",
    publicKey: string = "",
    privateKey: string = publicKey
  ) {
    if (!publicKey) {
      // 自动生成密钥对
      const keyPair = JWT.generateKey(algorithm);
      publicKey = keyPair.publicKey;
      privateKey = keyPair.privateKey;
    }
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.expirationTime = expirationTime;
    this.algorithm = algorithm;
  }
  /**
   * 将载荷数据转换为 JWT 令牌字符串
   * @param payload 载荷数据
   * @returns JWT 令牌字符串
   */
  public stringify(payload: T) {
    return JWS.sign(payload, this.privateKey, this.expirationTime, this.algorithm);
  }
  /**
   * 解析 JWT 令牌字符串
   * @param jwtToken JWT 令牌字符串
   * @returns JWS 对象
   */
  public parse(jwtToken: string) {
    return new JWS<T>(jwtToken);
  }
  /**
   * 验证 JWT 签名
   * @param jwt JWS 对象
   * @returns 验证结果，true 表示验证通过
   */
  public verify(jwt: JWS<T>) {
    return jwt.verify(this.publicKey, this.algorithm);
  }
  /**
   * 生成密钥对
   * @param algorithm 签名算法，默认为 HS512
   * @returns 密钥对对象
   */
  static generateKey(algorithm: string = "HS512") {
    // 对称算法（HMAC）
    if (algorithm.startsWith("HS")) {
      const privateKey = crypto.randomBytes(32).toString("hex");
      return { publicKey: privateKey, privateKey };
    }

    // RSA 和 RSA-PSS 算法
    if (algorithm.startsWith("RS") || algorithm.startsWith("PS")) {
      return crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048, // 密钥长度，RS256 建议至少 2048 位
        publicKeyEncoding: {
          type: "spki", // 公钥标准，适合 JWT 用的 PEM 格式
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8", // 私钥标准
          format: "pem",
        },
      });
    }
    // ECDSA 算法
    if (algorithm.startsWith("ES")) {
      // 不同 ECDSA 算法对应的椭圆曲线
      const curveMap = {
        ES256: "prime256v1",
        ES384: "secp384r1",
        ES512: "secp521r1",
      };
      return crypto.generateKeyPairSync("ec", {
        namedCurve: curveMap[algorithm],
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      });
    }
    throw new Error("不支持的算法：" + algorithm);
  }
}

/** 测试用例 */
// for (const alg of [
//   "HS256",
//   "HS384",
//   "HS512",
//   "ES256",
//   "ES384",
//   "ES512",
//   "RS256",
//   "RS384",
//   "RS512",
//   "PS256",
//   "PS384",
//   "PS512",
// ]) {
//   const jwt = new JWT(1000, alg);

//   const times = alg.startsWith("HS") ? 50000 : 500;
//   console.time(times + "次" + alg);
//   for (let i = 0; i < times; i++) {
//     const token = jwt.stringify({ userId: i, user: "admin" });
//     const data = jwt.parse(token);
//     if (jwt.verify(data) === false) throw new Error(alg + "校验失败");
//   }
//   console.timeEnd(times + "次" + alg);
// }
