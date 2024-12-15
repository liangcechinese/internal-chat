connOption = 
{ 
  ordered: true, 
  maxRetransmits: 10, // 最大重传次数
  bufferedAmountLowThreshold: 1024 * 16 // 设置缓冲区低阈值为 16KB
}
class XChatUser {
  id = null;
  isMe = false;

  rtcConn = null;
  connAddressTarget = null;
  connAddressMe = null;
  chatChannel = null;
  candidateArr = [];

  onicecandidate = () => { };
  onmessage = () => { };
  onReviceFile = () => { };
  onFileProgress = () => { };

  // 文件接收相关
  fileWriter = null;      // 新增：用于写入文件的 StreamSaver
  receivedSize = 0;
  fileInfo = null;
  tempBlob = null;       // 新增：临时存储小块数据
  tempChunks = [];       // 新增：临时块存储
  TEMP_CHUNK_SIZE = 1024 * 1024; // 1MB临时块大小

  async createConnection() {
    this.rtcConn = new RTCPeerConnection({ iceServers: [] });
    this.chatChannel = this.rtcConn.createDataChannel('chat',  connOption);
    this.dataChannel_initEvent()
    // this.dataChannel.onopen = () => console.log('DataChannel is open');
    // this.dataChannel.onclose = () => console.log('DataChannel is closed');
    const offer = this.rtcConn.createOffer()
    await this.rtcConn.setLocalDescription(offer)
    this.connAddressMe = this.rtcConn.localDescription;

    this.rtcConn.onicecandidate = event => {
      if (event.candidate) {
        this.candidateArr.push(event.candidate);
        this.onicecandidate(event.candidate, this.candidateArr);
      }
    };

    return this;
  }

  closeConnection() {
    if (this.rtcConn) {
      this.rtcConn.close();
    }
    this.rtcConn = null;
    this.chatChannel = null;
    this.connAddressTarget = null;
    this.connAddressMe = null;
    this.onicecandidate = () => { };
  }

  async connectTarget(target) {
    if (!target) {
      throw new Error('connAddressTarget is null');
    }
    if (this.isMe || !this.id) {
      return this;
    }
    if (this.rtcConn) {
      this.rtcConn.close();
      this.rtcConn = null;
      return this;
    }
    this.rtcConn = new RTCPeerConnection({ iceServers: [] });

    this.rtcConn.onicecandidate = event => {
      if (event.candidate) {
        this.candidateArr.push(event.candidate);
        this.onicecandidate(event.candidate, this.candidateArr);
      }
    };
    this.rtcConn.ondatachannel = (event) => {
      if (event.channel) {
        this.chatChannel = event.channel;
        this.dataChannel_initEvent();
      }
    };
    this.connAddressTarget = new RTCSessionDescription({ type: 'offer', sdp: target});
    await this.rtcConn.setRemoteDescription(this.connAddressTarget);
    
    this.connAddressMe = await this.rtcConn.createAnswer();
    this.rtcConn.setLocalDescription(this.connAddressMe);
    return this;
  }

  addIceCandidate(candidate) {
    if (!this.rtcConn) {
      return;
    }
    this.rtcConn.addIceCandidate(new RTCIceCandidate(candidate))
  }

  async setRemoteSdp(target) {
    if (this.rtcConn.signalingState === 'have-local-offer' && !this.rtcConn.remoteDescription) {
      // console.log('setRemoteDescription', target);
      try {

        this.rtcConn.setRemoteDescription({ type: 'answer', sdp: target})
        .then(() => console.log('Remote SDP set as answer.'))
        .catch(err => console.error('Error handling answer SDP:', err));
      } catch (err) {
        console.error('Error handling answer SDP:', err);
      }
    } else {
      // console.error('Cannot set answer SDP: signaling state is', peerConnection.signalingState);
    }
  }

  dataChannel_initEvent() {
    // 接收消息
    this.chatChannel.onmessage = async e => {
      const message = e.data;
      if (typeof message === 'string') {
        if (message.startsWith('##FILE_S##')) {
          // 文件传输开始
          this.receivedSize = 0;
          this.tempChunks = [];
          this.tempBlob = null;
          this.fileInfo = JSON.parse(message.substring(10));
          
          // 创建临时blob用于url生成
          this.tempBlob = new Blob([], { type: 'application/octet-stream' });
        } else if (message === '##FILE_E##') {
          // 文件传输结束
          if (this.tempChunks.length > 0) {
            const finalBlob = new Blob(this.tempChunks, { type: 'application/octet-stream' });
            const url = URL.createObjectURL(finalBlob);
            this.onReviceFile({ url, name: this.fileInfo.name });
          }
          // 清理资源
          this.tempChunks = [];
          this.tempBlob = null;
          this.fileInfo = null;
          this.receivedSize = 0;
        } else {
          this.onmessage(message);
        }
      } else if (this.fileInfo) {
        // 处理文件数据
        if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
          const chunk = message instanceof Uint8Array ? message.buffer : message;
          this.receivedSize += chunk.byteLength;
          
          // 将数据添加到临时chunks
          this.tempChunks.push(chunk);
          
          // 如果临时chunks累积超过阈值，创建blob并释放内存
          if (this.getTempChunksSize() > this.TEMP_CHUNK_SIZE) {
            const tempBlob = new Blob(this.tempChunks, { type: 'application/octet-stream' });
            this.tempChunks = [tempBlob]; // 只保留合并后的blob
          }
          
          // 触发进度回调
          const progress = Math.floor(this.receivedSize / this.fileInfo.size * 100);
          this.onFileProgress(progress, this.fileInfo);
        }
      }
    };

    this.chatChannel.onopen = () => console.log('chatChannel is open');
    this.chatChannel.onclose = () => console.log('DataChannel is closed');
  }

  // 新增：获取临时chunks的总大小
  getTempChunksSize() {
    return this.tempChunks.reduce((total, chunk) => {
      return total + (chunk instanceof Blob ? chunk.size : chunk.byteLength);
    }, 0);
  }

  checkBufferedAmount() {
    const maxBufferedAmount = 1024 * 256; // 增加到 256KB
    return this.chatChannel.bufferedAmount < maxBufferedAmount;
  }

  async sendFile(fileInfo, file) {
    try {
      const fileInfoStr = '##FILE_S##' + JSON.stringify(fileInfo);
      await this.sendMessage(fileInfoStr);
      await this.sendFileBytes(file);
      await this.sendMessage('##FILE_E##');
      return true;
    } catch (error) {
      console.error('Error sending file:', error);
      throw error;
    }
  }

  async sendFileBytes(file) {
    return new Promise((resolve, reject) => {
      const chunkSize = 32 * 1024; // 32KB chunks
      const totalChunks = Math.ceil(file.size / chunkSize);
      let currentChunk = 0;
      let aborted = false;

      const fileReader = new FileReader();
      
      fileReader.onload = async () => {
        try {
          while(!this.checkBufferedAmount() && !aborted) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          
          if (aborted) {
            return;
          }

          this.chatChannel.send(fileReader.result);
          currentChunk++;
          
          // 计算并触发进度回调
          const progress = Math.floor((currentChunk / totalChunks) * 100);
          this.onFileProgress(progress, { name: file.name, size: file.size });

          if (currentChunk < totalChunks) {
            sendNextChunk();
          } else {
            console.log('File sent successfully.');
            resolve();
          }
        } catch (e) {
          console.error('Error sending file chunk:', e);
          aborted = true;
          reject(e);
        }
      };

      fileReader.onerror = () => {
        console.error('Error reading file chunk');
        aborted = true;
        reject(new Error('File read error'));
      };

      const sendNextChunk = () => {
        const start = currentChunk * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);
        fileReader.readAsArrayBuffer(chunk);
      };

      sendNextChunk();
    });
  }

  async sendMessage(message) {
    if (!this.chatChannel) {
      console.log(this.id, '------chatChannel is null');
      return;
    }
    if (this.chatChannel.readyState === 'open') {
      await this.chatChannel.send(message);
    } else {
      throw new Error('DataChannel is not open');
    }
  }
}