# X 关注管理台 v1.0.0

适用于桌面版 Chrome 和 Microsoft Edge。目前扩展从 GitHub 分发，需要通过浏览器的开发者模式加载。

## 首次安装

1. 打开 [v1.0.0 发布页](https://github.com/Velpro6688/x-follow-manager/releases/tag/v1.0.0)，在 **Assets** 下下载 **Source code (zip)**。
2. 在文件管理器里解压 ZIP，把解压后的目录放在你准备长期保留的位置。
3. 在目标浏览器的地址栏输入扩展管理地址。Chrome 使用 `chrome://extensions/`，Edge 使用 `edge://extensions/`。
4. 开启「开发者模式」，点击「加载已解压的扩展程序」或「加载解压缩的扩展」。
5. 打开解压后的目录，选中里面的 `x-follow-manager` 文件夹。该文件夹的第一层应能看到 `manifest.json`。
6. 扩展管理页出现「X 关注管理台」即表示加载成功。已打开的 X 页面需要刷新一次。进入自己账号的「正在关注」或「关注者」列表，就可以看到管理面板。

先扫描，再在名单中挑选或排除账号，核对后确认执行。未知结果请先人工复查。

## 常见问题

- **找不到加载按钮**。先确认已打开扩展管理页并开启「开发者模式」。如果电脑由单位管理且浏览器禁用了该功能，请联系管理员。
- **提示找不到清单文件**。检查选择的目录是否直接包含 `manifest.json`，通常需要在解压目录内再进入一层 `x-follow-manager`。
- **加载成功却看不到面板**。确认扩展在当前浏览器配置中已启用，刷新 X，再进入自己账号的关注或粉丝列表。
- **怎样更新**。将新版扩展文件放到原来加载的扩展目录，在扩展管理页点击该扩展的「重新加载」，然后刷新 X。

Windows 和 macOS 上供普通 Chrome 用户直接安装的扩展，需要由 Chrome 网上应用店托管并签名。目前的 GitHub 源码包适用上面的手动加载流程。[Chrome 分发说明](https://developer.chrome.com/docs/extensions/how-to/distribute) · [Chrome 加载说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) · [Edge 加载说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)

MIT License，作者 Velpro。分发时须保留 LICENSE 与 NOTICE.md。

项目与使用说明：https://github.com/Velpro6688/x-follow-manager
