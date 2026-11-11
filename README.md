<p align="center">
  <img src="x-follow-manager/icons/icon-128.png" width="80" alt="X 关注管理台图标">
</p>

<h1 align="center">X 关注管理台</h1>

<p align="center">在 X 上扫描关注关系、管理排除名单，确认后分批取关或回关。</p>

<p align="center"><strong>v1.0.0</strong> · 桌面 Chrome / Microsoft Edge · Manifest V3 · 本地运行</p>


<p align="center">
  <a href="../../releases/tag/v1.0.0"><strong>下载 v1.0.0</strong></a>
  · <a href="#安装">安装说明</a>
  · <a href="../../issues/new/choose">反馈与建议</a>
</p>

---

## 功能与界面

在 X 的「正在关注」列表识别未回关账号，在「关注者」列表挑选需要回关的人。先扫描、再选择，只有核对名单并确认后才执行。

![主面板：查看关注关系统计、挑选数量与扫描状态](docs/screenshots/01-panel.png)

> 图片是插件在本地模拟 X 页面中的运行截图，使用合成账号展示界面，不包含个人关注列表。

| 看清关系 | 挑选与保护 | 核对后执行 |
| --- | --- | --- |
| 区分未回关、已回关和未知状态；停止扫描会保留已有结果。 | 搜索昵称或用户名，勾选候选，把想保留的人加入排除名单。 | 确认名单与数量后分批处理，结束后分别展示成功、失败和待复查结果。 |

- **扫描与恢复**。可暂停或停止扫描。中断的扫描进度会在本机按账号和列表保存，返回同一列表时可以恢复。
- **批次保护**。执行前复查列表身份、严格校验和单批上限。切换列表后清空旧选择。检测到页面已有原生确认窗口时，停止当前批次。
- **显示设置**。支持浅色、深色界面和九种界面语言。弹窗可跟随浏览器语言，设置保存失败时会提示并恢复上一次保存的值。

## 名单管理与粉丝回关

| 搜索、勾选、排除 | 核对待回关名单 |
| :---: | :---: |
| [![未回关名单](docs/screenshots/02-roster.png)](docs/screenshots/02-roster.png) | [![粉丝回关名单](docs/screenshots/05-followback.png)](docs/screenshots/05-followback.png) |

排除名单保存在本机。页面使用「突出候选」保留原生列表高度；需要只看某一类账号时，打开名单窗口筛选。

## 执行前核对，执行后复查

| 确认本批名单与数量 | 查看逐个账号的处理结果 |
| :---: | :---: |
| [![执行前确认](docs/screenshots/03-confirm.png)](docs/screenshots/03-confirm.png) | [![执行结果](docs/screenshots/04-result.png)](docs/screenshots/04-result.png) |

开始时优先定位本批最靠后的目标，再向前逐个处理。虚拟列表变化时可能需要校正位置；无法确认的结果会单独列出，方便人工复查。

## 安装

**[下载 v1.0.0 源码 ZIP](../../archive/refs/tags/v1.0.0.zip)**

1. 解压 GitHub 提供的源码 ZIP，保留解压后的目录。
2. 打开对应浏览器的扩展管理页：

| Chrome | Microsoft Edge |
| --- | --- |
| `chrome://extensions/` | `edge://extensions/` |

3. 开启「开发者模式」，选择「加载已解压的扩展程序」。
4. 选择包含 `manifest.json` 的 `x-follow-manager` 文件夹，然后刷新 X 页面。

Chrome 与 Edge 使用同一份扩展文件。当前通过开发者模式安装。更新时解压新版、重新加载扩展，再刷新 X。

## 设置与使用

<p align="center">
  <img src="docs/screenshots/06-settings.png" width="368" alt="扩展弹窗：单批上限、严格校验与排除名单设置">
</p>

1. 在自己账号的关注或粉丝列表点击「开始扫描」。扫描阶段只读取页面；切到后台后会尽力继续，受限时切回页面可恢复。
2. 打开「名单」，搜索、勾选并排除需要保留的账号。
3. 核对本批人数与名单，勾选确认后执行。
4. 查看处理结果。遇到「结果未知」时先人工复查，避免重复执行。

初始版本支持手动扫描、批量取关和批量回关。定时执行当前处于关闭状态。

## 反馈与建议

- **Bug 或功能建议**。可在 GitHub 提交反馈，也可以使用安全说明中列出的反馈邮箱。[GitHub Issues](../../issues/new/choose) · [反馈邮箱](SECURITY.md)
- 请注明扩展版本、浏览器版本、复现步骤和预期结果。截图、日志和账号信息请先脱敏；不要发送密码、Cookie 或访问令牌。
- 涉及可被利用的安全问题，请参阅安全说明，不要公开漏洞细节。

## 数据与使用边界

- **本地保存**：设置、排除名单和未完成扫描进度保存在扩展本地存储；扫描进度定期保存，但不能保证最后一次保存成功。没有项目后端、遥测或广告服务。参阅 [隐私说明](PRIVACY.md)。
- **登录与校验**：需要正常登录 X。扩展不索取密码或访问令牌；无法核实页面身份或关注关系时会阻止执行。
- **平台限制**：X 的自动化规则禁止用脚本操作网站。扩展在网页上批量取关或回关可能触发限流、验证或账号处置。参阅 [X 自动化规则](https://help.x.com/en/rules-and-policies/x-automation)。

<details>
<summary><strong>开发与测试</strong></summary>

需要 Node.js 22 或以上。

```sh
npm ci
npm test
npm run e2e -- interactionaudit
```

端到端测试会自行启动本地测试台，使用合成账号。可通过 `CHROME_PATH` 指定 Chrome 或 Edge 可执行文件。手动预览时运行 `npm run serve`，然后打开 `http://localhost:38080/alice/following`。

Windows 打包：`powershell -NoProfile -ExecutionPolicy Bypass -File tools/build.ps1`。

</details>

## 许可

[MIT](LICENSE)，作者 **Velpro**。允许商用、修改与分发，须保留版权声明与许可全文。第三方组件遵循各自许可证，详见 [第三方声明](NOTICE.md)。
