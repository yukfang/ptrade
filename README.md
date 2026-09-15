# 银河证券 QMT 策略笔记

在 Cursor 里写脚本，拷到 **Windows VM 里的银河 QMT** 运行。本机 Mac **不能**连 QMT。

## 环境

- 券商：银河证券 QMT 实盘（交易终端-北京）
- 策略 Python：`#coding:gbk`，入口 `init` / `handlebar`
- 不是 MiniQMT，不要用 `xtquant`
- Web：Node（Express），准备部署到 Azure Web App

## 桥接系统（进行中）

目标：QMT 只负责读写柜台；浏览器 UI 在 Azure 上，避免在 VM 里操作。

| 编号 | 内容 | 状态 |
|---|---|---|
| [1] | QMT 拉挂盘/委托/成交并 POST 到服务器 | 策略已写，待 Azure 地址 |
| [2] | 服务器下发挂单/撤单，QMT 执行 | 以后再做（`GET /api/commands` 现返回空） |
| [3] | Web UI 展示挂盘/委托/成交 | 已有一页表格，1 秒刷新 |
| [4] | QMT 推 debug log；本机每秒拉取落盘 | 已写 |

QMT 始终当 HTTP 客户端往外连，不在 VM 里开端口。

券商客户端拉委托目前不需要我们这边的 token；**Azure 公网 API 建议设置 `BRIDGE_TOKEN`**，否则成交明细谁都能看。QMT 下单 token 以后做 [2] 再查。

### 本地起服务器

```bash
npm install
npm start
```

浏览器打开 http://127.0.0.1:3000

### 拉 debug 日志（给 Cursor 读）

```bash
BRIDGE_URL=http://127.0.0.1:3000 python3 tools/pull_logs.py
```

日志写入 `logs/qmt-debug.log`。Azure 就绪后改 `BRIDGE_URL`。

### QMT 侧

1. 编辑 `strategies/qmt_bridge.py`：填 `ACCOUNT`、`BASE_URL`（Azure 站点根 URL）
2. 全文贴进 QMT，**交易里实盘启动**，周期 3–5 秒
3. 不要回测，不要点下单

## 已确认能用

| 事项 | 结论 |
|---|---|
| 代码写法 | 深市 ETF：`159781.SZ` |
| 最新快照 | `ContextInfo.get_full_tick`，Level-1 快照不是逐笔 |
| 外网 POST | VM 能访问公网 HTTP 并读 response |
| 账户委托/成交 | 必须实盘。`get_trade_detail_data(account, 'stock', 'order'\|'deal')` |

## 仓库文件

- `strategies/tick_push_once.py`：tick 快照 POST httpcan（已验证）
- `strategies/account_orders_deals.py`：实盘打印挂盘/成交明细（已验证）
- `strategies/qmt_bridge.py`：持续推 sync + debug 到 Web
- `server/`：Express API + UI
- `tools/pull_logs.py`：每秒拉 `/api/debug` 到本地

## API

- `POST /api/sync` 挂盘/委托/成交
- `GET /api/state` UI 用
- `POST /api/debug` QMT 日志
- `GET /api/debug?after=ID` 本机拉日志
- `GET /api/commands` 占位，返回 `[]`
- `GET /api/health`

可选请求头：`X-Bridge-Token`（环境变量 `BRIDGE_TOKEN`）

## 注意

- 试验策略不要下单。
- 行情/成交只自用，不要转发。
- Azure publish profile 拿到后再部署；不要把 profile 提交进 git。
