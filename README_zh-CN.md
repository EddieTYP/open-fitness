# Open Fitness

语言：[English](README.md) | [繁體中文](README_zh-TW.md) | 简体中文

Open Fitness 是一套私密、自托管的健身记录工具，把训练、饮食、身体测量、恢复和
训练计划放在一起。你可以继续使用原有的健身 App 和设备，不必再从聊天、笔记和
不同的导出文件中拼凑自己的进展。

平时可以直接用适合手机操作的网页界面记录，也可以导入固定格式的数据。如果想用
照片，或直接打几句话来记录，还可以连接 AI 助手；即使不用 AI，网页界面也能独立
运行。

| 今天 | 饮食 |
| --- | --- |
| ![使用合成训练计划展示的 Open Fitness 手机端今天页面](docs/assets/open-fitness-today-mobile.png) | ![使用合成待定餐食计划展示的 Open Fitness 手机端饮食页面](docs/assets/open-fitness-nutrition-mobile.png) |

## 训练、饮食和进展

### 训练

- 自定义训练日和恢复日的顺序，不限于 Leg／Push／Pull。
- 建立固定课表和替代动作，并标记普通训练、减量训练或测试训练。
- 同一次训练可以一口气完成，也可以分时段、分地点记录。
- 查看相关的上一次训练作为比较。只有经过你的确认，进阶调整才会写入训练计划。

### 饮食

- 保存常吃的食物和餐食组合。
- 分开显示待定餐食计划和已经吃过的餐食。
- 跟踪热量和蛋白质目标。
- 可选择从 iPhone 快捷指令等来源导入暂定或已结算的 Active Energy。

### 进展

- 查看体重、身体成分、力量、心肺和恢复的长期变化。
- 修改记录时保留原有信息，不会在没有提示的情况下覆盖。
- 在日志中查看完整时间线，不必依赖聊天记录。

## 记录方式

三种记录方式最终都会更新同一个 SQLite 数据库：

1. **网页界面：** 适合快速手动记录和日常查看。
2. **AI 助手（可选）：** 适合处理照片、自然语言汇报、修改、提问，以及根据记录
   提供建议。
3. **结构化导入：** 适合格式固定、会反复出现的数据。

AI 助手通过随附插件写入数据时，Open Fitness 会先检查内容，只执行一次更改，
再读取实际保存的结果，确认无误后才报告成功。没有提供的数据会留空，不会自行
猜测。

[Open Fitness 的工作方式](docs/WORKFLOWS.md)（英文）进一步说明了数据来源、
写入流程和隐私边界。

## 安装 Open Fitness

Open Fitness 目前供单个用户使用。你需要 Git、Node.js 22.18 或更高版本，以及
一台由你管理、能安全保存应用和 SQLite 数据库的电脑。

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/EddieTYP/open-fitness.git
cd open-fitness
npm ci
```

然后按照[通用自托管指南](docs/operations/SELF-HOSTING.md)：

1. 在仓库外新建一个空数据库；
2. 生成登录密码哈希和彼此独立的密钥；
3. 将 `.env.example` 复制为只有你能读取的 `.env.local`；
4. 构建应用，并让它只在本机开放；
5. 如需远程访问，再通过私有 HTTPS 或由你管理的 VPN 开放。

登录后设置语言、时区、目标、训练周期和营养目标，就可以直接使用网页界面。

[新用户入门指南](docs/ONBOARDING.md)（英文）包含从空数据库开始，到可选导入和
AI 设置的完整步骤。

## 连接 AI 助手（可选）

`agent-plugin/` 目录提供可移植的
[Agent Plugins v1](https://agent-plugins.org/specification) 插件。兼容的客户端会
加载 Open Fitness skill 和两个工具：

- `fitness_read` 只获取当前任务所需的数据；
- `fitness_write` 检查更改内容，并核对实际保存的结果。

Open Fitness 不限定模型提供商、聊天 App、记忆系统或 AI 客户端。插件不含任何
凭据；客户端需要通过私有环境或密钥存储提供 `FITNESS_API_BASE_URL` 和
`FITNESS_API_TOKEN`。

AI 助手适合处理不方便逐项输入的内容，但正式记录仍保存在 Open Fitness。发送
健康数据或照片前，请先查看所选 AI 提供商的数据保留、模型训练和隐私条款。

设置方法见[可选 AI 设置](docs/ONBOARDING.md#3-connect-any-compatible-agent-optional)
（英文）。[Hermes](integrations/hermes/README.md) 是其中一个兼容客户端，但并非
使用 Open Fitness 的必要条件。

## 数据和隐私

- SQLite 数据库是正式记录。
- 网页登录、AI 访问和数据导入分别使用不同的凭据。
- 健康记录、凭据、数据库、导出文件和私有证书不应提交到 Git。
- 应用默认只在本机开放；如需远程访问，请自行设置私有 HTTPS 或 VPN。
- 通过 AI 客户端发送的数据，也受所选提供商的隐私条款约束。

连接 AI 前请先阅读[新用户入门指南](docs/ONBOARDING.md)；迁移或恢复数据库前，
请阅读[备份与恢复](docs/operations/BACKUP-RESTORE.md)（英文）。

## 语言和当前范围

产品和网页界面支持 `en`、`zh-HK`、`zh-TW` 和 `zh-CN`。语言设置会应用于系统
生成的训练计划、训练回顾、进展说明和日志标签。用户指定的文字、品牌或产品名称，
以及直接导入的字段会保留原文。AI 为保存内容撰写文字时，会使用个人资料中设置的
语言；界面不会重新翻译已有记录。详情见[国际化说明](docs/I18N.md)（英文）。

0.1.0 版是面向单个用户的自托管版本，不包含托管云服务、多用户账户或原生 iOS
App。Open Fitness 不是医疗器械，不能替代专业医疗建议。

## 文档

| 指南 | 内容 |
| --- | --- |
| [新用户入门指南](docs/ONBOARDING.md) | 首次设置和可选连接 |
| [通用自托管指南](docs/operations/SELF-HOSTING.md) | 安装、启动和安全升级 |
| [备份与恢复](docs/operations/BACKUP-RESTORE.md) | 保护和恢复 SQLite 数据库 |
| [Open Fitness 的工作方式](docs/WORKFLOWS.md) | 数据来源、写入流程和隐私边界 |
| [产品愿景](docs/PRODUCT-VISION.md) | 设计原则、发展方向和不包含的功能 |
| [安全政策](SECURITY.md) | 私下报告安全漏洞 |

## 开发

```bash
npm ci
npm run check
npm run lint
npm test
npm run build
```

请勿让开发或测试环境连接正在使用的 SQLite 数据库。数据库和版本操作记录在
`docs/operations/` 中；如果缺少必要路径或安全检查，相关工具会停止运行。

## 许可证

Open Fitness 核心应用代码采用 [AGPL-3.0-or-later](LICENSE) 许可证。许可证范围和
第三方项目见 [NOTICE](NOTICE)。如机构需要其他条款，可向版权持有人咨询商业许可。

在正式发布贡献许可条款前，暂不接受外部代码贡献；详情见
[CONTRIBUTING.md](CONTRIBUTING.md)。
