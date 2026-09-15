#coding:gbk
"""
QMT -> Web 桥接（只读）。实盘启动，不要回测。

填好 BASE_URL、ACCOUNT 后全文贴进银河 QMT。
周期建议 3秒/5秒，太长则网页刷新慢。
不下单、不撤单。
"""

ACCOUNT = '220500068710'
STOCK_UNIVERSE = '159781.SZ'
BASE_URL = 'https://ptrade.console.enrichlife.today'
TOKEN = ''  # 若服务器设了 BRIDGE_TOKEN，这里填同一个
HEARTBEAT_SEC = 5

OPEN_STATUS = set([48, 49, 50, 51, 52, 55])
ACC_TYPES = ('stock', 'STOCK', 'credit', 'CREDIT')


def _now():
    import time
    return time.time()


def _json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=True, default=str)


def _http_json(path, payload=None, method='POST'):
    body = None
    if payload is not None:
        raw = _json_dumps(payload)
        body = raw.encode('utf-8') if hasattr(raw, 'encode') else raw
    try:
        try:
            from urllib.request import Request, urlopen
        except ImportError:
            from urllib2 import Request, urlopen
        url = BASE_URL.rstrip('/') + path
        req = Request(url, data=body)
        if method != 'POST':
            try:
                req.get_method = lambda: method
            except Exception:
                pass
        req.add_header('Content-Type', 'application/json')
        if TOKEN:
            req.add_header('X-Bridge-Token', TOKEN)
        resp = urlopen(req, timeout=8)
        content = resp.read()
        if hasattr(content, 'decode'):
            content = content.decode('utf-8', 'replace')
        return resp.getcode(), content
    except Exception as e:
        return -1, '%s %s' % (type(e).__name__, e)


def _public_attrs(obj):
    names = [n for n in dir(obj) if n.startswith('m_')]
    if not names:
        names = [n for n in dir(obj) if not n.startswith('_') and not n.isupper()]
    out = {}
    for name in names:
        try:
            val = getattr(obj, name)
        except Exception:
            continue
        if callable(val):
            continue
        if isinstance(val, (int, float, bool)) or val is None:
            out[name] = val
        else:
            try:
                out[name] = val if isinstance(val, str) else str(val)
            except Exception:
                out[name] = repr(val)
    return out


def _g(row, *keys):
    for key in keys:
        if hasattr(row, key):
            val = getattr(row, key)
            if val is not None and val != '':
                return val
    return ''


def _side_text(row):
    name = str(_g(row, 'm_strOptName'))
    if '卖' in name:
        return '卖'
    if '买' in name:
        return '买'
    raw = _g(row, 'm_nOffsetFlag', 'm_nDirection')
    try:
        code = int(raw)
    except Exception:
        return str(raw)
    if code in (49, 1):
        return '卖'
    if code in (48, 0):
        return '买'
    return str(code)


def _code_of(row):
    for key in ('m_strInstrumentID', 'm_strStockCode', 'stockcode', 'stock_code'):
        if hasattr(row, key):
            return str(getattr(row, key))
    return ''


def _filter_stock(rows):
    if not rows:
        return []
    want = STOCK_UNIVERSE.replace('.SZ', '').replace('.SH', '')
    out = []
    for row in rows:
        code = _code_of(row)
        if want in code or STOCK_UNIVERSE in code:
            out.append(row)
    return out


def _is_open_order(row):
    try:
        return int(getattr(row, 'm_nOrderStatus', -1)) in OPEN_STATUS
    except Exception:
        return False


def _resolve_trade_fn(ContextInfo):
    try:
        import builtins as bi
    except ImportError:
        import __builtin__ as bi
    for n in ('get_trade_detail_data', 'get_trade_detail'):
        for obj in (bi, globals(), ContextInfo):
            fn = obj.get(n) if isinstance(obj, dict) else getattr(obj, n, None)
            if callable(fn):
                return fn
    return None


def _try_get(fn, account, acc_type, data_name):
    try:
        return fn(account, acc_type, data_name), None
    except Exception as e:
        return None, '%s %s' % (type(e).__name__, e)


def _query_all(fn, account, names):
    last = None
    for acc_type in ACC_TYPES:
        for name in names:
            data, err = _try_get(fn, account, acc_type, name)
            if err or data is None:
                continue
            if data:
                return data
            last = data
    return last


def _deal_view(row):
    d = _public_attrs(row)
    d['code'] = _code_of(row)
    d['side'] = _side_text(row)
    d['price'] = _g(row, 'm_dPrice', 'm_dAveragePrice', 'm_dTradePrice')
    d['qty'] = _g(row, 'm_nVolume', 'm_nTradeVolume', 'm_nVolumeTraded')
    d['time'] = _g(row, 'm_strTradeTime', 'm_strInsertTime', 'm_strTime')
    d['date'] = _g(row, 'm_strTradeDate', 'm_strInsertDate', 'm_strDate')
    d['trade_id'] = _g(row, 'm_strTradeID', 'm_strDealID', 'm_strExecID')
    d['order_id'] = _g(row, 'm_strOrderSysID', 'm_strOrderRef', 'm_strOrderID')
    return d


def _order_view(row):
    d = _public_attrs(row)
    d['code'] = _code_of(row)
    d['side'] = _side_text(row)
    d['price'] = _g(row, 'm_dLimitPrice', 'm_dPrice')
    d['qty'] = _g(row, 'm_nVolumeTotalOriginal', 'm_nVolume')
    d['status'] = _g(row, 'm_nOrderStatus')
    d['time'] = _g(row, 'm_strInsertTime', 'm_strOrderTime')
    d['order_id'] = _g(row, 'm_strOrderSysID', 'm_strOrderRef')
    return d


def _debug(ContextInfo, message, level='info'):
    print(message)
    lines = getattr(ContextInfo, 'dbg_lines', None)
    if lines is None:
        ContextInfo.dbg_lines = []
        lines = ContextInfo.dbg_lines
    lines.append({'level': level, 'message': str(message)})


def _flush_debug(ContextInfo):
    lines = getattr(ContextInfo, 'dbg_lines', None)
    if not lines:
        return
    code, content = _http_json('/api/debug', {'lines': lines})
    print('debug http', code, str(content)[:200])
    ContextInfo.dbg_lines = []


def init(ContextInfo):
    ContextInfo.last_push = 0
    ContextInfo.last_hash = ''
    ContextInfo.dbg_lines = []
    ContextInfo.set_universe([STOCK_UNIVERSE])
    if ACCOUNT and hasattr(ContextInfo, 'set_account'):
        try:
            ContextInfo.set_account(ACCOUNT)
            _debug(ContextInfo, 'set_account ok')
        except Exception as e:
            _debug(ContextInfo, 'set_account error: %s' % e, 'error')
    _debug(ContextInfo, 'bridge init %s -> %s' % (STOCK_UNIVERSE, BASE_URL))
    _flush_debug(ContextInfo)


def handlebar(ContextInfo):
    now = _now()
    if now - getattr(ContextInfo, 'last_push', 0) < HEARTBEAT_SEC:
        return

    if not BASE_URL or '你的azure' in BASE_URL or not ACCOUNT:
        _debug(ContextInfo, '请填写 BASE_URL 和 ACCOUNT', 'error')
        _flush_debug(ContextInfo)
        ContextInfo.last_push = now
        return

    fn = _resolve_trade_fn(ContextInfo)
    if fn is None:
        _debug(ContextInfo, '找不到 get_trade_detail_data', 'error')
        _flush_debug(ContextInfo)
        ContextInfo.last_push = now
        return

    orders = _query_all(fn, ACCOUNT, ['order', 'ORDER']) or []
    deals = _query_all(fn, ACCOUNT, ['deal', 'DEAL', 'trade', 'TRADE']) or []
    stock_orders = _filter_stock(orders)
    stock_deals = _filter_stock(deals)
    open_orders = [_order_view(o) for o in stock_orders if _is_open_order(o)]
    order_views = [_order_view(o) for o in stock_orders]
    deal_views = [_deal_view(d) for d in stock_deals]

    payload = {
        'account': ACCOUNT,
        'stock': STOCK_UNIVERSE,
        'openOrders': open_orders,
        'orders': order_views,
        'deals': deal_views,
    }
    code, content = _http_json('/api/sync', payload)
    _debug(ContextInfo, 'sync http %s orders=%s deals=%s open=%s body=%s' % (
        code, len(order_views), len(deal_views), len(open_orders), str(content)[:180]))
    ContextInfo.last_push = now
    _flush_debug(ContextInfo)
