// ============================================================
//  AI 平台适配注册表（多开管理器的「埋线」）
//
//  一份程序可以管理多个 AI 平台：默认内置豆包（图片 / 视频生成），
//  其他平台由用户在「账号矩阵 → 平台管理」里自行添加，写清楚
//  登录页和对话页地址即可。判断登录状态用 Cookie 域名，不写死豆包。
//
//  kind:
//    doubao  内置深度适配（页面探针 + 图像/视频面板识别 + 下载回收）
//    generic 通用适配（自动找输入框 / 上传入口 / 发送按钮 / 结果），
//            绝大多数「网页上能登录、能对话」的 AI 平台都能直接用，
//            个别站点结构特殊时，改 lib/generic-agent.js 里的选择器即可。
// ============================================================
const fs = require('fs');
const path = require('path');

const BUILTIN = [
  {
    id: 'doubao',
    name: '豆包',
    vendor: '字节跳动',
    kind: 'doubao',
    homeUrl: 'https://www.doubao.com/chat/',
    loginUrl: 'https://www.doubao.com/chat/',
    chatUrl: 'https://www.doubao.com/chat/',
    cookieDomains: ['.doubao.com', 'doubao.com'],
    note: '内置深度适配 · 免费图片 / 视频生成（Seedance）',
    builtin: true
  }
];

function hostToCookieDomain(u) {
  try {
    const h = new URL(u).hostname;
    const parts = h.split('.');
    const base = parts.length > 2 ? parts.slice(-2).join('.') : h;
    return [h, '.' + base];
  } catch (e) { return []; }
}

function norm(input = {}) {
  const id = String(input.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const loginUrl = String(input.loginUrl || input.homeUrl || input.chatUrl || '').trim();
  const chatUrl = String(input.chatUrl || input.homeUrl || loginUrl || '').trim();
  const domains = Array.isArray(input.cookieDomains) && input.cookieDomains.length
    ? input.cookieDomains.map(String).filter(Boolean)
    : hostToCookieDomain(chatUrl || loginUrl);
  return {
    id,
    name: String(input.name || '').trim() || id,
    vendor: String(input.vendor || '').trim(),
    kind: input.kind === 'doubao' ? 'doubao' : 'generic',
    homeUrl: String(input.homeUrl || chatUrl).trim(),
    loginUrl,
    chatUrl,
    cookieDomains: domains,
    ua: String(input.ua || '').trim(),
    note: String(input.note || '').trim(),
    builtin: false,
    createdAt: Number(input.createdAt) || Date.now()
  };
}

class ProviderStore {
  constructor(file) {
    this.file = file;
    this.custom = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      const arr = Array.isArray(raw) ? raw : (raw && raw.providers) || [];
      this.custom = arr.map(norm).filter(p => p.id && p.chatUrl && !BUILTIN.some(b => b.id === p.id));
    } catch (e) { this.custom = []; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ providers: this.custom }, null, 2), 'utf-8');
    } catch (e) { /* 写不进去也不影响本次运行 */ }
  }

  list() { return [...BUILTIN, ...this.custom]; }

  get(id) {
    const all = this.list();
    return all.find(p => p.id === id) || BUILTIN[0];
  }

  add(input) {
    const p = norm(input);
    if (!p.id) return { ok: false, err: '平台标识只能用小写字母 / 数字 / 短横线' };
    if (!p.chatUrl || !/^https?:\/\//i.test(p.chatUrl)) return { ok: false, err: '请填写完整的对话页地址（https://…）' };
    if (this.list().some(x => x.id === p.id)) return { ok: false, err: '这个平台标识已经存在' };
    p.loginUrl = p.loginUrl || p.chatUrl;
    p.homeUrl = p.homeUrl || p.chatUrl;
    this.custom.push(p);
    this.save();
    return { ok: true, provider: p };
  }

  update(id, patch) {
    const p = this.custom.find(x => x.id === id);
    if (!p) return { ok: false, err: '只能修改自己添加的平台（内置平台不可改）' };
    const next = norm({ ...p, ...patch, id: p.id });
    if (!next.chatUrl || !/^https?:\/\//i.test(next.chatUrl)) return { ok: false, err: '对话页地址不合法' };
    Object.assign(p, next);
    this.save();
    return { ok: true, provider: p };
  }

  remove(id) {
    const before = this.custom.length;
    this.custom = this.custom.filter(p => p.id !== id);
    if (this.custom.length === before) return { ok: false, err: '内置平台不能删除' };
    this.save();
    return { ok: true };
  }
}

module.exports = { ProviderStore, BUILTIN, hostToCookieDomain };
