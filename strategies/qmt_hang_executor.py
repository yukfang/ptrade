#coding:gbk
"""
从 Web 拉取 UI 发起的买挂/卖挂，并在实盘执行。

必须「交易」里实盘启动，不要回测。
与 qmt_bridge.py 可同时运行：bridge 只读推送，本策略只负责下单。

流程：
  GET  /api/commands
  POST /api/commands/{id}/claim
  passorder 限价买/卖
  POST /api/commands/{id}/result
"""

ACCOUNT = '220500068710'
STOCK_UNIVERSE = '159781.SZ'
BASE_URL = 'https://ptrade.console.enrichlife.today'
TOKEN = ''
POLL_SEC = 2
STRATEGY_NAME = 'qmt_hang_exec'


def _now():
    import time
    return time.time()


def _json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=True, default=str)


def _http_json(path, payload=None, method='GET'):
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
        if method != 'POST' and body is None:
            try:
                req.get_method = lambda: method
            except Exception:
                pass
        if method == 'POST' or body is not None:
            req.add_header('Content-Type', 'application/json')
            try:
                req.get_method = lambda: 'POST'
            except Exception:
                pass
        if TOKEN:
            req.add_header('X-Bridge-Token', TOKEN)
        resp = urlopen(req, timeout=8)
        content = resp.read()
        if hasattr(content, 'decode'):
            content = content.decode('utf-8', 'replace')
        return resp.getcode(), content
    except Exception as e:
        return -1, '%s %s' % (type(e).__name__, e)


def _parse_json(content):
    import json
    try:
        return json.loads(content)
    except Exception:
        return None


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
    code, content = _http_json('/api/debug', {'lines': lines}, method='POST')
    print('debug http', code, str(content)[:160])
    ContextInfo.dbg_lines = []


def _resolve_passorder(ContextInfo):
    try:
        import builtins as bi
    except ImportError:
        import __builtin__ as bi
    for n in ('passorder', 'order_shares'):
        for obj in (bi, globals(), ContextInfo):
            fn = obj.get(n) if isinstance(obj, dict) else getattr(obj, n, None)
            if callable(fn):
                return n, fn
    return None, None


def _place_limit(ContextInfo, side, stock, price, qty, account):
    """
    迅投/银河常见限价：
      buy  passorder(23, 1101, account, stock, 11, price, qty, name, 2, ContextInfo)
      sell passorder(24, 1101, account, stock, 11, price, qty, name, 2, ContextInfo)
    若签名不同，日志会打出异常，再按券商文档改。
    """
    name, fn = _resolve_passorder(ContextInfo)
    if not fn:
        return False, 'passorder not found'

    op = 23 if side == 'buy' else 24
    try:
        if name == 'passorder':
            # opType, orderType, accountid, orderCode, prType, price, volume, strategyName, quickTrade, ContextInfo
            ret = fn(op, 1101, account, stock, 11, float(price), int(qty), STRATEGY_NAME, 2, ContextInfo)
            return True, str(ret)
        # order_shares(stockcode, amount, style, price, ContextInfo, accountid)
        # amount>0 buy, <0 sell; style often LimitOrderStyle(price)
        amount = int(qty) if side == 'buy' else -int(qty)
        try:
            style = LimitOrderStyle(float(price))  # noqa: F821
        except Exception:
            style = float(price)
        ret = fn(stock, amount, style, float(price), ContextInfo, account)
        return True, str(ret)
    except Exception as e:
        return False, '%s %s' % (type(e).__name__, e)


def _fetch_commands():
    code, content = _http_json('/api/commands?limit=10', method='GET')
    data = _parse_json(content)
    if code != 200 or not data or not data.get('ok'):
        return [], 'GET /api/commands http=%s body=%s' % (code, str(content)[:180])
    return data.get('commands') or [], None


def _claim(cmd_id):
    code, content = _http_json('/api/commands/%s/claim' % cmd_id, {}, method='POST')
    data = _parse_json(content)
    if code != 200 or not data or not data.get('ok'):
        return None, 'claim http=%s body=%s' % (code, str(content)[:180])
    return data.get('command'), None


def _result(cmd_id, ok, broker_order_id='', error=''):
    payload = {'ok': bool(ok), 'brokerOrderId': broker_order_id or '', 'error': error or ''}
    code, content = _http_json('/api/commands/%s/result' % cmd_id, payload, method='POST')
    return code, content


def hang_poll(ContextInfo):
    try:
        _run_once(ContextInfo)
    except Exception as e:
        print('hang_poll error:', type(e).__name__, e)


def _try_start_run_time(ContextInfo):
    if not hasattr(ContextInfo, 'run_time'):
        return False
    period = '%dnSecond' % int(POLL_SEC)
    try:
        ContextInfo.run_time('hang_poll', period, '2020-01-01 09:30:00')
        _debug(ContextInfo, 'run_time ok period=%s' % period)
        return True
    except Exception as e:
        _debug(ContextInfo, 'run_time failed: %s %s' % (type(e).__name__, e), 'error')
        return False


def _poll_loop(ContextInfo):
    import time
    while not getattr(ContextInfo, 'stop_poll', False):
        try:
            _run_once(ContextInfo)
        except Exception as e:
            print('poll error:', type(e).__name__, e)
        time.sleep(POLL_SEC)


def _run_once(ContextInfo):
    if not BASE_URL or not ACCOUNT:
        _debug(ContextInfo, '请填写 BASE_URL 和 ACCOUNT', 'error')
        _flush_debug(ContextInfo)
        return

    cmds, err = _fetch_commands()
    if err:
        _debug(ContextInfo, err, 'error')
        _flush_debug(ContextInfo)
        return
    if not cmds:
        return

    for cmd in cmds:
        cid = cmd.get('id')
        claimed, cerr = _claim(cid)
        if cerr or not claimed:
            _debug(ContextInfo, 'skip %s: %s' % (cid, cerr or 'empty'), 'error')
            continue
        side = str(claimed.get('side') or '')
        stock = str(claimed.get('stock') or STOCK_UNIVERSE)
        price = claimed.get('price')
        qty = claimed.get('qty')
        account = str(claimed.get('account') or ACCOUNT)
        _debug(ContextInfo, 'exec id=%s %s %s @%s x%s' % (cid, side, stock, price, qty))
        ok, detail = _place_limit(ContextInfo, side, stock, price, qty, account)
        if ok:
            _result(cid, True, broker_order_id=str(detail)[:64], error='')
            _debug(ContextInfo, 'done id=%s ret=%s' % (cid, str(detail)[:120]))
        else:
            _result(cid, False, error=str(detail)[:500])
            _debug(ContextInfo, 'fail id=%s %s' % (cid, detail), 'error')
    _flush_debug(ContextInfo)


def init(ContextInfo):
    ContextInfo.dbg_lines = []
    ContextInfo.stop_poll = False
    ContextInfo.set_universe([STOCK_UNIVERSE])
    if ACCOUNT and hasattr(ContextInfo, 'set_account'):
        try:
            ContextInfo.set_account(ACCOUNT)
            _debug(ContextInfo, 'set_account ok')
        except Exception as e:
            _debug(ContextInfo, 'set_account error: %s' % e, 'error')
    _debug(ContextInfo, 'hang executor init %s -> %s poll=%ss' % (STOCK_UNIVERSE, BASE_URL, POLL_SEC))

    if _try_start_run_time(ContextInfo):
        _run_once(ContextInfo)
        _flush_debug(ContextInfo)
        return

    _debug(ContextInfo, 'fallback blocking poll loop')
    _flush_debug(ContextInfo)
    _poll_loop(ContextInfo)


def handlebar(ContextInfo):
    return
