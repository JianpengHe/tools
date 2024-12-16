/** 参考：https://github.com/xiangyuecn/Recorder */
import * as fs from "fs";
const HeaderEID = [0x1a, 0x45, 0xdf, 0xa3];
const SegmentEID = [0x18, 0x53, 0x80, 0x67];
const ClusterEID = [0x1f, 0x43, 0xb6, 0x75];

export class WebmToPCM {
  constructor() {}
  private multiHeader = 0;
  private tracks = {};
  private audioTrackIdx = 0;
  private audioTrack0: any = {};
  public onData(data: Uint16Array) {}
  //   private rawData: number[] = [];
  private isPcm = false;
  private position = [0];
  private isFirst = true;

  private readSimpleBlock(fileBytes: Uint8Array) {
    while (this.position[0] < fileBytes.length) {
      var eid1 = this.readMatroskaVInt(fileBytes, this.position);
      //SimpleBlock
      if (this.BytesEq(eid1, [0xa3])) {
        var bytes1 = this.readMatroskaBlock(fileBytes, this.position);
        var trackNo = bytes1[0] & 0xf;
        var track = this.tracks[trackNo];
        if (!track) throw new Error("轨道#" + trackNo + "的信息不存在");
        if (track.type == "audio" && track.audioTrackIdx === 0) {
          // console.log(bytes1.length - 4);
          var uint8 = new Uint8Array(bytes1.length - 4);
          for (var i = 4; i < bytes1.length; i++) {
            //  this.rawData.push(bytes1[i]);
            uint8[i - 4] = bytes1[i];
          }

          if (this.isPcm || (/(\b|_)PCM\b/i.test(track.codec) && track.channels > 0 && track.bitDepth == 32)) {
            //pcm数据转换成16位播放
            this.isPcm = true;
            var floatArr = new Float32Array(uint8.buffer);
            var data = new Uint16Array(floatArr.length / track.channels);
            for (var i = 0, dataIndex = 0; i < floatArr.length; i += track.channels) {
              var s = Math.max(-1, Math.min(1, floatArr[i]));
              data[dataIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            this.onData(data);
          } else {
            throw new Error("不支持非pcm的webm");
          }
        }
        //End SimpleBlock
      } else {
        return eid1;
      }
    }
    return null;
  }
  /** 循环读取 Header+Segment */
  private HeaderLoop(fileBytes: Uint8Array) {
    let eid0: number[] | null;
    //循环读取Cluster
    while (
      this.position[0] < fileBytes.length &&
      (eid0 = this.readSimpleBlock(fileBytes)) /**this.readMatroskaVInt(fileBytes, this.position) ;*/
    ) {
      //Cluster
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
            this.position[0] -= HeaderEID.length; //退回一下
            this.HeaderLoop(fileBytes);
            return;
            //continue HeaderLoop;
          }
          if (this.BytesEq(eid1, ClusterEID)) {
            //下一个Cluster
            this.position[0] -= ClusterEID.length; //退回一下
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

      //Track
      if (this.BytesEq(eid0, [0x16, 0x54, 0xae, 0x6b])) {
        //循环读取TrackEntry
        while (pos0[0] < bytes0.length) {
          var eid1 = this.readMatroskaVInt(bytes0, pos0);
          var bytes1Len = [];
          var bytes1 = this.readMatroskaBlock(bytes0, pos0, bytes1Len);
          var pos1 = [0];
          //TrackEntry
          if (this.BytesEq(eid1, [0xae])) {
            var track: any = {};
            while (true) {
              if (pos1[0] >= bytes1.length) break;
              var eid2 = this.readMatroskaVInt(bytes1, pos1);
              var bytes2 = this.readMatroskaBlock(bytes1, pos1);
              var pos2 = [0];
              if (this.BytesEq(eid2, [0xd7])) {
                //Track Number
                var val = this.BytesInt(bytes2);
                track.number = val;
                if (this.multiHeader == 1) {
                  this.tracks[val] = track;
                }
              } else if (this.BytesEq(eid2, [0x83])) {
                //Track Type
                var val = this.BytesInt(bytes2);
                if (val == 1) track.type = "video";
                else if (val == 2) {
                  track.type = "audio";
                  if (this.multiHeader == 1) {
                    track.audioTrackIdx = this.audioTrackIdx++;
                    if (track.audioTrackIdx == 0) {
                      this.audioTrack0 = track;
                    }
                  }

                  track.srcBytes = [0xae];
                  track.srcBytes.push(...bytes1Len);
                  track.srcBytes.push(...bytes1);
                } else {
                  track.type = "Type-" + val;
                }
              } else if (this.BytesEq(eid2, [0x86])) {
                //Track Codec
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
              //多个Header时，不支不同持轨道参数
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
  public write(fileBytes: Uint8Array) {
    console.log(fileBytes.length);
    try {
      if (this.isFirst) {
        //EBML Header
        var eid = this.readMatroskaVInt(fileBytes, this.position);
        if (!this.BytesEq(eid, HeaderEID)) {
          throw new Error("未识别到此WebM文件Header");
        }
        this.multiHeader++;
        //跳过EBML Header内容
        this.readMatroskaBlock(fileBytes, this.position);

        //Segment
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
    this.position[0] = 0;
    //  fs.writeFileSync("1.pcm", new Uint8Array(this.playData));
  }

  /**  两个字节数组内容是否相同 */
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

  /** 字节数组转成ASCII字符串 */
  private BytesStr(bytes) {
    var str = "";
    for (var i = 0; i < bytes.length; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  /** 字节数组BE转成int数字 */
  private BytesInt(bytes) {
    var s = ""; //0-8字节，js位运算只支持4字节
    for (var i = 0; i < bytes.length; i++) {
      var n = bytes[i];
      s += (n < 16 ? "0" : "") + n.toString(16);
    }
    return parseInt(s, 16) || 0;
  }

  /** 字节数组BE转成4|8字节浮点数 */
  private BytesFloat(bytes) {
    if (bytes.length == 4) {
      return new Float32Array(new Uint8Array(bytes.reverse()).buffer)[0];
    } else if (bytes.length == 8) {
      return new Float64Array(new Uint8Array(bytes.reverse()).buffer)[0];
    }
    throw new Error("浮点数长度必须为4或8");
  }

  /** 读取一个可变长数值字节数组 */
  private readMatroskaVInt(arr: Uint8Array | number[], pos: number[], trimArr?: number[]) {
    var i = pos[0];
    var b0 = arr[i],
      b2 = ("0000000" + b0.toString(2)).substr(-8);
    var m = /^(0*1)(\d*)$/.exec(b2);
    if (!m) throw new Error("readMatroskaVInt首字节无效: " + i);
    var len = m[1].length;
    var val: number[] = [];
    for (var i2 = 0; i2 < len && i < arr.length; i2++) {
      val[i2] = arr[i];
      if (trimArr) trimArr[i2] = arr[i];
      i++;
    }
    if (trimArr) {
      trimArr[0] = parseInt(m[2] || "0", 2);
    }
    pos[0] = i;
    return val;
  }

  /** 读取一个自带长度的内容字节数组 */
  private readMatroskaBlock(arr: Uint8Array | number[], pos: number[], lenBytes?: number[]) {
    var lenVal: number[] = [];
    var lenBytes2 = this.readMatroskaVInt(arr, pos, lenVal);
    if (lenBytes) lenBytes.push(...lenBytes2);

    var len = this.BytesInt(lenVal);
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
    pos[0] = i;
    return new Uint8Array(val);
  }
}
// const w = fs.createWriteStream("1.pcm");
// const webmToPCM = new WebmToPCM();
// webmToPCM.onData = a => w.write(Buffer.from(a.buffer));
// webmToPCM.write(fs.readFileSync("1.webm"));
