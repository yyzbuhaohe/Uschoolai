/* 把 run-all 改造成可外部控制：每轮检查 control.json */
const fs = require('fs');
const CTRL = require('path').join(__dirname, 'control.json');
function readCtrl() {
  try { return JSON.parse(fs.readFileSync(CTRL, 'utf8')); } catch (e) { return { state: 'running' }; }
}
module.exports = { readCtrl, CTRL };