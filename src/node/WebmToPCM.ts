/**
 * WebmToPCM.ts - WebM格式音频转PCM格式工具
 * 参考：https://github.com/xiangyuecn/Recorder
 *
 * 本文件实现了WebM格式音频文件解析和转换为PCM格式的功能。
 * WebM是一种基于Matroska容器格式的开放媒体文件格式，常用于存储音视频数据。
 * PCM(脉冲编码调制)是一种未经压缩的音频数据格式。
 */
// import * as fs from "fs";

/**
 * Matroska格式关键标识符(Element ID)
 * 这些是WebM文件中特定段落的标识符，用于解析文件结构
 */
const HeaderEID = [0x1a, 0x45, 0xdf, 0xa3]; // EBML头部标识符
const SegmentEID = [0x18, 0x53, 0x80, 0x67]; // 段落标识符
const ClusterEID = [0x1f, 0x43, 0xb6, 0x75]; // 簇标识符(包含音视频数据)

/**
 * WebM转PCM解析器类
 * 用于将WebM格式的音频数据转换为PCM格式
 */
export class WebmToPCM {
  constructor() {}

  /** 多个Header计数器，用于处理多个头部信息的情况 */
  private multiHeader = 0;

  /** 存储所有轨道信息的对象 */
  private tracks = {};

  /** 音频轨道索引 */
  private audioTrackIdx = 0;

  /** 第一个音频轨道的信息 */
  private audioTrack0: any = {};

  /**
   * 数据输出回调函数
   * 当解析出PCM数据时会调用此函数
   * @param data 解析出的PCM数据
   */
  public onData(data: Uint16Array) {}

  //   private rawData: number[] = []; // 原始数据存储(已注释)

  /** 标识当前处理的是否为PCM格式 */
  private isPcm = false;

  /** 当前解析位置指针(数组形式便于在函数间传递引用) */
  private position = [0];

  /** 是否为第一次处理文件 */
  private isFirst = true;

  /**
   * 读取并处理SimpleBlock块
   * SimpleBlock是WebM中包含实际音视频数据的块
   * @param fileBytes 文件字节数组
   * @returns 下一个Element ID或null
   */
  private readSimpleBlock(fileBytes: Uint8Array) {
    while (this.position[0] < fileBytes.length) {
      var eid1 = this.readMatroskaVInt(fileBytes, this.position);
      //SimpleBlock
      if (this.BytesEq(eid1, [0xa3])) {
        var bytes1 = this.readMatroskaBlock(fileBytes, this.position);
        var trackNo = bytes1[0] & 0xf; // 提取轨道号(低4位)
        var track = this.tracks[trackNo];
        if (!track) throw new Error("轨道#" + trackNo + "的信息不存在");
        if (track.type == "audio" && track.audioTrackIdx === 0) {
          // console.log(bytes1.length - 4);
          // 提取音频数据(跳过前4个字节的头信息)
          var uint8 = new Uint8Array(bytes1.length - 4);
          for (var i = 4; i < bytes1.length; i++) {
            //  this.rawData.push(bytes1[i]);
            uint8[i - 4] = bytes1[i];
          }

          // 处理PCM格式的音频数据
          if (this.isPcm || (/(\b|_)PCM\b/i.test(track.codec) && track.channels > 0 && track.bitDepth == 32)) {
            //pcm数据转换成16位播放
            this.isPcm = true;
            var floatArr = new Float32Array(uint8.buffer);
            var data = new Uint16Array(floatArr.length / track.channels);
            // 将32位浮点PCM转换为16位整数PCM
            for (var i = 0, dataIndex = 0; i < floatArr.length; i += track.channels) {
              var s = Math.max(-1, Math.min(1, floatArr[i])); // 限制值在-1到1之间
              data[dataIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff; // 负值映射到-32768~0，正值映射到0~32767
            }
            this.onData(data); // 输出转换后的PCM数据
          } else {
            throw new Error("不支持非pcm的webm");
          }
        }
        //End SimpleBlock
      } else {
        return eid1; // 返回当前Element ID，表示SimpleBlock处理结束
      }
    }
    return null; // 文件处理完毕
  }

  /**
   * 循环读取Header和Segment
   * 这是WebM文件解析的主循环
   * @param fileBytes 文件字节数组
   */
  private HeaderLoop(fileBytes: Uint8Array) {
    let eid0: number[] | null;
    //循环读取Cluster
    while (
      this.position[0] < fileBytes.length &&
      (eid0 = this.readSimpleBlock(fileBytes)) /**this.readMatroskaVInt(fileBytes, this.position) ;*/
    ) {
      //Cluster - 包含音视频数据的簇
      if (this.BytesEq(eid0, ClusterEID)) {
        //跳过Cluster长度值
        this.readMatroskaVInt(fileBytes, this.position);

        var bytes0 = fileBytes;
        var pos0 = this.position;
        // var bytesTime0: number[] = [];

        //循环读取SimpleBlock
        while (pos0[0] < bytes0.length) {
          const eid1 = this.readMatroskaVInt(bytes0, pos0);
          if (this.BytesEq(eid1, HeaderEID)) {
            //下一个Header+Segment
            this.position[0] -= HeaderEID.length; //退回一下，以便正确处理下一个Header
            this.HeaderLoop(fileBytes);
            return;
            //continue HeaderLoop;
          }
          if (this.BytesEq(eid1, ClusterEID)) {
            //下一个Cluster
            this.position[0] -= ClusterEID.length; //退回一下，以便正确处理下一个Cluster
            break;
          }

          // var pos0_ = pos0[0];
          //   var bytes1Len = [];
          var bytes1 = this.readMatroskaBlock(
            bytes0,
            pos0,
            //, bytes1Len
          );
          var pos1 = [0];
          if (this.BytesEq(eid1, [0xe7])) {
            //Cluster 的当前时间
            // bytesTime0 = [0xe7];
            // for (var i = pos0_; i < pos0[0]; i++) {
            //   bytesTime0.push(bytes0[i]);
            // }
            continue;
          }

          //SimpleBlock
          // if (this.BytesEq(eid1, [0xa3])) {
          //   var trackNo = bytes1[0] & 0xf;
          //   var track = this.tracks[trackNo];
          //   if (!track) throw new Error("轨道#" + trackNo + "的信息不存在");
          //   if (track.type == "audio" && track.audioTrackIdx === 0) {
          //     //  console.log(bytes1.length - 4);
          //     var uint8 = new Uint8Array(bytes1.length - 4);
          //     for (var i = 4; i < bytes1.length; i++) {
          //       //  this.rawData.push(bytes1[i]);
          //       uint8[i - 4] = bytes1[i];
          //     }

          //     if (this.isPcm || (/(\b|_)PCM\b/i.test(track.codec) && track.channels > 0 && track.bitDepth == 32)) {
          //       //pcm数据转换成16位播放
          //       this.isPcm = true;
          //       var floatArr = new Float32Array(uint8.buffer);
          //       var data = new Uint16Array(floatArr.length / track.channels);
          //       for (var i = 0, dataIndex = 0; i < floatArr.length; i += track.channels) {
          //         var s = Math.max(-1, Math.min(1, floatArr[i]));
          //         data[dataIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          //       }
          //       this.onData(data);
          //     } else {
          //       throw new Error("不支持非pcm的webm");
          //     }
          //   }
          // }
          //End SimpleBlock
        }
        // console.log("读完了", pos0[0], bytes0.length);
        continue;
      }
      //End Cluster

      var bytes0: Uint8Array = this.readMatroskaBlock(fileBytes, this.position);
      var pos0 = [0];

      //Track - 轨道信息
      if (this.BytesEq(eid0, [0x16, 0x54, 0xae, 0x6b])) {
        //循环读取TrackEntry
        while (pos0[0] < bytes0.length) {
          var eid1 = this.readMatroskaVInt(bytes0, pos0);
          var bytes1Len = [];
          var bytes1 = this.readMatroskaBlock(bytes0, pos0, bytes1Len);
          var pos1 = [0];
          //TrackEntry - 单个轨道条目
          if (this.BytesEq(eid1, [0xae])) {
            var track: any = {};
            while (true) {
              if (pos1[0] >= bytes1.length) break;
              var eid2 = this.readMatroskaVInt(bytes1, pos1);
              var bytes2 = this.readMatroskaBlock(bytes1, pos1);
              var pos2 = [0];
              if (this.BytesEq(eid2, [0xd7])) {
                //Track Number - 轨道编号
                var val = this.BytesInt(bytes2);
                track.number = val;
                if (this.multiHeader == 1) {
                  this.tracks[val] = track;
                }
              } else if (this.BytesEq(eid2, [0x83])) {
                //Track Type - 轨道类型
                var val = this.BytesInt(bytes2);
                if (val == 1)
                  track.type = "video"; // 视频轨道
                else if (val == 2) {
                  track.type = "audio"; // 音频轨道
                  if (this.multiHeader == 1) {
                    track.audioTrackIdx = this.audioTrackIdx++;
                    if (track.audioTrackIdx == 0) {
                      this.audioTrack0 = track; // 保存第一个音频轨道
                    }
                  }

                  track.srcBytes = [0xae];
                  track.srcBytes.push(...bytes1Len);
                  track.srcBytes.push(...bytes1);
                } else {
                  track.type = "Type-" + val; // 其他类型轨道
                }
              } else if (this.BytesEq(eid2, [0x86])) {
                //Track Codec - 轨道编解码器
                track.codec = this.BytesStr(bytes2);
              } else if (this.BytesEq(eid2, [0xe0]) || this.BytesEq(eid2, [0xe1])) {
                //循环读取 Video 或 Audio 属性
                while (true) {
                  if (pos2[0] >= bytes2.length) break;
                  var eid3 = this.readMatroskaVInt(bytes2, pos2);
                  var bytes3 = this.readMatroskaBlock(bytes2, pos2);
                  //采样率、位数、声道数
                  if (this.BytesEq(eid3, [0xb5])) track.sampleRate = Math.round(this.BytesFloat(bytes3));
                  else if (this.BytesEq(eid3, [0x62, 0x64])) track.bitDepth = this.BytesInt(bytes3);
                  else if (this.BytesEq(eid3, [0x9f])) track.channels = this.BytesInt(bytes3);
                  //宽高
                  else if (this.BytesEq(eid3, [0xb0])) track.width = this.BytesInt(bytes3);
                  else if (this.BytesEq(eid3, [0xba])) track.height = this.BytesInt(bytes3);
                }
              }
            }
            if (this.multiHeader > 1) {
              //多个Header时，不支持不同轨道参数
              var tk = this.tracks[track.number];
              if (
                !tk ||
                tk.type != track.type ||
                tk.codec != track.codec ||
                tk.sampleRate != track.sampleRate ||
                tk.bitDepth != track.bitDepth ||
                tk.channels != track.channels
              ) {
                console.log(tk, track);
                throw new Error("WebM中有多个header时，不支持不一致的轨道参数");
              }
            }
            console.log(track);
            continue;
          }
          //End TrackEntry
          //不认识的，忽略
        }
        continue;
      }
      //End Track

      //不认识的，忽略
    }
    //End Cluster
  }

  /**
   * 写入并处理WebM文件数据
   * 这是解析WebM文件的入口方法
   * @param fileBytes WebM文件的字节数组
   */
  public write(fileBytes: Uint8Array) {
    console.log(fileBytes.length);
    try {
      if (this.isFirst) {
        //EBML Header - 解析文件头
        var eid = this.readMatroskaVInt(fileBytes, this.position);
        if (!this.BytesEq(eid, HeaderEID)) {
          throw new Error("未识别到此WebM文件Header");
        }
        this.multiHeader++;
        //跳过EBML Header内容
        this.readMatroskaBlock(fileBytes, this.position);

        //Segment - 解析段落信息
        var eid = this.readMatroskaVInt(fileBytes, this.position);
        if (!this.BytesEq(eid, SegmentEID)) {
          throw new Error("未识别到此WebM文件Segment");
        }
        //跳过Segment长度值
        this.readMatroskaVInt(fileBytes, this.position);
        this.isFirst = false;
      }
      this.HeaderLoop(fileBytes);
      //End Header+Segment
    } catch (e: any) {
      console.log(fileBytes);
      console.error(e);
      throw new Error("解析WebM文件提取音频异常：" + e.message);
    }
    // if (!this.rawData.length) {
    //   throw new Error("未提取到此WebM文件的音频数据");
    // }

    // console.log({
    //   fileBytes,
    //   // rawData: Buffer.from(this.rawData),
    //   rawTrack: this.audioTrack0,

    //   // playBlob: new Uint8Array(this.playData).buffer,
    //   playType: this.isPcm ? "pcm" : "webm",
    //   playSampleRate: this.audioTrack0.sampleRate || 0,
    //   playBitRate: this.isPcm ? 16 : 0,

    //   webmTracks: this.tracks,
    //   multiHeader: this.multiHeader,
    // });
    this.position[0] = 0; // 重置位置指针，便于处理下一个文件
    //  fs.writeFileSync("1.pcm", new Uint8Array(this.playData));
  }

  /**
   * 两个字节数组内容是否相同
   * @param bytes1 第一个字节数组
   * @param bytes2 第二个字节数组
   * @returns 是否相同
   */
  private BytesEq(bytes1, bytes2) {
    if (bytes2.length == 1) {
      if (bytes1.length == 1) {
        return bytes1[0] == bytes2[0];
      }
      return false;
    }
    if (bytes1.length != bytes2.length) {
      return false;
    }
    for (var i = 0; i < bytes1.length; i++) {
      if (bytes1[i] != bytes2[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * 字节数组转成ASCII字符串
   * @param bytes 字节数组
   * @returns ASCII字符串
   */
  private BytesStr(bytes) {
    var str = "";
    for (var i = 0; i < bytes.length; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  /**
   * 字节数组BE(大端序)转成int数字
   * @param bytes 字节数组
   * @returns 整数值
   */
  private BytesInt(bytes) {
    var s = ""; //0-8字节，js位运算只支持4字节
    for (var i = 0; i < bytes.length; i++) {
      var n = bytes[i];
      s += (n < 16 ? "0" : "") + n.toString(16);
    }
    return parseInt(s, 16) || 0;
  }

  /**
   * 字节数组BE(大端序)转成4|8字节浮点数
   * @param bytes 字节数组
   * @returns 浮点数值
   */
  private BytesFloat(bytes) {
    if (bytes.length == 4) {
      return new Float32Array(new Uint8Array(bytes.reverse()).buffer)[0]; // 4字节转Float32
    } else if (bytes.length == 8) {
      return new Float64Array(new Uint8Array(bytes.reverse()).buffer)[0]; // 8字节转Float64
    }
    throw new Error("浮点数长度必须为4或8");
  }

  /**
   * 读取一个可变长数值字节数组
   * Matroska格式使用EBML编码，其中Element ID和数据长度都是可变长度的
   * @param arr 源字节数组
   * @param pos 当前位置指针(引用传递)
   * @param trimArr 可选，用于存储处理后的值
   * @returns 读取到的字节数组
   */
  private readMatroskaVInt(arr: Uint8Array | number[], pos: number[], trimArr?: number[]) {
    var i = pos[0];
    var b0 = arr[i],
      b2 = ("0000000" + b0.toString(2)).substr(-8); // 转为8位二进制字符串
    var m = /^(0*1)(\d*)$/.exec(b2); // 匹配前导0和首个1
    if (!m) throw new Error("readMatroskaVInt首字节无效: " + i);
    var len = m[1].length; // 获取长度标识(前导0的数量+1)
    var val: number[] = [];
    for (var i2 = 0; i2 < len && i < arr.length; i2++) {
      val[i2] = arr[i];
      if (trimArr) trimArr[i2] = arr[i];
      i++;
    }
    if (trimArr) {
      trimArr[0] = parseInt(m[2] || "0", 2); // 将首字节的有效位存入trimArr
    }
    pos[0] = i; // 更新位置指针
    return val;
  }

  /**
   * 读取一个自带长度的内容字节数组
   * @param arr 源字节数组
   * @param pos 当前位置指针(引用传递)
   * @param lenBytes 可选，用于存储长度字节
   * @returns 读取到的内容字节数组
   */
  private readMatroskaBlock(arr: Uint8Array | number[], pos: number[], lenBytes?: number[]) {
    var lenVal: number[] = [];
    var lenBytes2 = this.readMatroskaVInt(arr, pos, lenVal); // 读取长度值
    if (lenBytes) lenBytes.push(...lenBytes2);

    var len = this.BytesInt(lenVal); // 转换为整数
    var i = pos[0];
    var val: number[] = [];
    // console.log("len", len);
    if (len < 0x7fffffff) {
      //超大值代表没有长度
      for (var i2 = 0; i2 < len && i < arr.length; i2++) {
        val[i2] = arr[i];
        i++;
      }
    }
    pos[0] = i; // 更新位置指针
    return new Uint8Array(val);
  }
}

// 使用示例(已注释)
// const w = fs.createWriteStream("1.pcm");
// const webmToPCM = new WebmToPCM();
// webmToPCM.onData = a => w.write(Buffer.from(a.buffer));
// webmToPCM.write(fs.readFileSync("1.webm"));
