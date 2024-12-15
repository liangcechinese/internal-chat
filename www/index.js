var users = [];
var me = new XChatUser();

function setRemote() {
  me.setRemoteSdp(remoteSDP.value);
}
function addLinkItem(uid, file) {
  const chatBox = document.querySelector('.chat-wrapper');
  const chatItem = document.createElement('div');
  chatItem.className = 'chat-item';
  chatItem.innerHTML = `
    <div class="chat-item_user">${uid === me.id ? '（我）': ''}${uid} :</div>
    <div class="chat-item_content"><a class="file" href="${file.url}" download="${file.name}">[文件] ${file.name}</a></div>
  `;
  chatBox.appendChild(chatItem);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addChatItem(uid, message) {
  const chatBox = document.querySelector('.chat-wrapper');
  const chatItem = document.createElement('div');
  chatItem.className = 'chat-item';
  const msg = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  chatItem.innerHTML = `
    <div class="chat-item_user">${uid === me.id ? '（我）': ''}${uid} :</div>
    <div class="chat-item_content"><pre>${msg}</pre></div>
  `;
  chatBox.appendChild(chatItem);
  chatBox.scrollTop = chatBox.scrollHeight;

}
function sendMessage(msg) {
  const message = msg ?? messageInput.value;
  addChatItem(me.id, message);
  users.forEach(u => {
    if (u.isMe) {
      return;
    }
    u.sendMessage(message);
  });
  messageInput.value = '';
}

async function sendFile(file) {
  const fileInfo = { name: file.name, size: file.size };
  const progressId = `progress-${me.id}-${file.name}-${Date.now()}`; // 添加时间戳避免重名
  
  // 创建进度条
  const chatBox = document.querySelector('.chat-wrapper');
  const progressItem = document.createElement('div');
  progressItem.className = 'chat-item';
  progressItem.innerHTML = `
    <div class="chat-item_user">${me.id}（我）:</div>
    <div class="chat-item_content">
      <div>[文件上传] ${file.name} (${formatFileSize(file.size)})</div>
      <div class="progress-bar-container">
        <div id="${progressId}" class="progress-bar" style="width: 0%"></div>
      </div>
      <div class="progress-text">准备上传...</div>
    </div>
  `;
  chatBox.appendChild(progressItem);
  chatBox.scrollTop = chatBox.scrollHeight;

  for (const u of users) {
    if (u.isMe) {
      continue;
    }

    const progressBar = document.getElementById(progressId);
    const progressText = progressBar.parentElement.nextElementSibling;

    // 添加进度回调
    u.onFileProgress = (progress, info) => {
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressText.textContent = `上传中... ${progress}%`;
      }
    };

    try {
      await u.sendFile(fileInfo, file);
      if (progressBar) {
        progressBar.style.backgroundColor = '#4CAF50';
        progressText.textContent = '传输完成';
      }
    } catch (error) {
      console.error('File transfer error:', error);
      if (progressBar) {
        progressBar.style.backgroundColor = '#f44336';
        progressText.textContent = '传输失败';
      }
    }
  }
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function registCandidate() {
  for (const ca of JSON.parse(candidate.value)) {
    me.addIceCandidate(ca);
  }
}


function connectAllOther() {
  if (users.length <= 1) {
    return;
  }
  const targets = users.filter(u => u.id !== me.id);
  for (const target of targets) {
    target.onicecandidate = (candidate) => {
      // console.log('candidate', candidate);
      signalingServer.send(JSON.stringify({uid: me.id, targetId: target.id, type: '9001', data: { candidate }}));
    }
    target.createConnection().then(() => {
      // console.log('targetAddr', target.connAddressMe);
      signalingServer.send(JSON.stringify({uid: me.id, targetId: target.id, type: '9002', data: { targetAddr: target.connAddressMe }}));
    })
  }
}


function refreshUsers(data) {
  resUsers = data.map(
    u => {
      let uOld = users.find(uOld => uOld.id === u.id)
      if (uOld) {
        return uOld;
      }
      let xchatUser = new XChatUser();
      xchatUser.id = u.id;
      xchatUser.isMe = u.id === me.id;
      return xchatUser;
    }
  );

  // 找出删除的用户
  const delUsers = users.filter(u => !resUsers.find(u2 => u2.id === u.id));
  delUsers.forEach(u => {
    u.closeConnection();
  });

  users = resUsers;
  for (const u of users) {
    u.onmessage = (msg) => {
      addChatItem(u.id, msg);
    }
    u.onReviceFile = (file) => {
      addLinkItem(u.id, file);
    }
  }
  refreshUsersHTML();
}

function joinedRoom() {
  connectAllOther();
}

function addCandidate(data) {
  users.find(u => u.id === data.targetId).addIceCandidate(data.candidate);
}
async function joinConnection(data) {
  const user = users.find(u => u.id === data.targetId)
  if (!user) {
    return;
  }
  user.onicecandidate = (candidate) => {
    // console.log('candidate', candidate);
    signalingServer.send(JSON.stringify({uid: me.id, targetId: user.id, type: '9001', data: { candidate }}));
  }
  await user.connectTarget(data.offer.sdp)
  signalingServer.send(JSON.stringify({uid: me.id, targetId: user.id, type: '9003', data: { targetAddr: user.connAddressMe }}));
}

async function joinedConnection(data) {
  const target = users.find(u => u.id === data.targetId)
  if (!target) {
    return;
  }
  await target.setRemoteSdp(data.answer.sdp);
}

function refreshUsersHTML() {
  document.querySelector('#users').innerHTML = users.map(u => `<li>${u.id}${u.isMe?'（我）':''}</li>`).join('');
}

function enterTxt(event) {
  if (event.ctrlKey || event.shiftKey) {
    return;
  }
  if (event.keyCode === 13) {
    sendMessage();
    event.preventDefault();
  }
}

// 连接信令服务器
const signalingServer = new WebSocket('wss://neiwang.1024bugs.com/ws');
signalingServer.onopen = () => {
  console.log('Connected to signaling server');
  setInterval(() => {
    signalingServer.send(JSON.stringify({type: '9999'}));
  }, 1000 * 10);
}
signalingServer.onmessage = ({ data: responseStr }) => {
  const response = JSON.parse(responseStr);
  const { type, data } = response;

  if (type === '1001') {
    me.id = data.id;
    return;
  }
  if (type === '1002') {
    refreshUsers(data);
    return;
  }
  if (type === '1003') {
    joinedRoom()
    return;
  }
  if (type === '1004') {
    addCandidate(data);
    return;
  }
  if (type === '1005') {
    joinConnection(data);
    return;
  }
  if (type === '1006') {
    joinedConnection(data);
    return;
  }
}
