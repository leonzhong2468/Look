// 任务持久化
const fs = require('fs');
const path = require('path');

class Store {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'tasks.json');
    this.tasks = [];
    this.load();
  }

  load() {
    // 主文件可能因为断电/强杀被截断（JSON 解析失败），那就退到 .tmp：
    // save() 是「先写 .tmp 再改名」，所以 .tmp 一旦存在，它本身是完整的
    const readArr = (f) => {
      try {
        const arr = JSON.parse(fs.readFileSync(f, 'utf-8'));
        return Array.isArray(arr) ? arr : null;
      } catch (e) { return null; }
    };
    let arr = readArr(this.file);
    if (!arr) arr = readArr(this.file + '.tmp');
    this.tasks = arr || [];
    // 上次退出时还在跑的任务，重启后标记为中断
    for (const t of this.tasks) {
      if (t.status === 'running') {
        t.status = 'paused';
        t.stepText = '上次运行中断，可点击「继续」重跑当前步骤';
        t.error = t.error || '程序退出导致中断';
      }
    }
  }

  save() {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      // 原子写：写临时文件再改名。直接覆盖写一旦在写入途中断电，
      // tasks.json 会变成半截 JSON，load() 解析失败就会把整个任务历史清空。
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), 'utf-8');
      try {
        fs.renameSync(tmp, this.file);            // Windows 上是 MOVEFILE_REPLACE_EXISTING，原子替换
      } catch (e) {
        fs.copyFileSync(tmp, this.file);          // 极端情况下（文件被占用）退一步，至少不丢数据
        try { fs.unlinkSync(tmp); } catch (e2) {}
      }
    } catch (e) {
      try { console.error('保存任务失败', e); } catch (e2) {}
    }
  }

  all() { return this.tasks; }

  get(id) { return this.tasks.find(t => t.id === id); }

  add(task) {
    this.tasks.unshift(task);
    this.save();
    return task;
  }

  update(id, patch) {
    const t = this.get(id);
    if (!t) return null;
    Object.assign(t, patch);
    this.save();
    return t;
  }

  remove(id) {
    this.tasks = this.tasks.filter(t => t.id !== id);
    this.save();
  }

  taskDir(id) {
    const d = path.join(this.root, 'files', id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

module.exports = { Store };
