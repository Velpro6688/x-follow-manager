# NOTICE

## 参考的第三方项目

本扩展在设计与页面结构适配上参考了以下开源项目：

**mts-x-following-list（X 清道夫）**
- 作者：imartinstudio
- 地址：https://github.com/imartinstudio/mts-x-following-list
- 许可证：MIT License

### 参考范围

- X 关注列表页的 DOM 结构特征（`data-testid="UserCell"`、`userFollowIndicator`、
  `data-testid$="-unfollow"`、`confirmationSheetConfirm` 等选择器）
- 面板插入位置、复选框挂载方式等交互思路

上述选择器属于 X 页面本身的结构事实，不构成对源代码的复制。

### 实现独立性声明

本扩展的全部源代码为独立编写，未复制、未修改、未打包上述项目的任何源码文件，
也未读写该扩展的存储数据。两者可以同时安装、互不影响。

### MIT License 原文（适用于上述参考项目）

```
MIT License

Copyright (c) imartinstudio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## X（Twitter）平台规则

本扩展通过模拟用户点击操作 X 页面，属于客户端自动化行为。
使用前请阅读并遵守 X 的服务条款与自动化规则：
https://help.x.com/en/rules-and-policies/x-automation

批量取消关注可能触发限流、验证或账号处置，风险由使用者自行承担。
