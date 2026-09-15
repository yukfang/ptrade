#coding:gbk
"""
查询本账号今日挂单（未完成委托）和成交。只读，不下单。

必须「实盘运行 / 启动」，不要点「回测」。
回测里即使用户当天在账户里成交过，这里也一定是空的。

ACCOUNT 填资金账号；init 里会 set_account。
"""

ACCOUNT = ''
STOCK_UNIVERSE = '159781.SZ'

ORDER_STATUS = {
    48: '未报',
    49: '待报',
    50: '已报',
    51: '已报待撤',
    52: '部成待撤',
    53: '部撤',
    54: '已撤',
    55: '部成',
    56: '已成',
    57: '废单',
}

OPEN_STATUS = set([48, 49, 50, 51, 52, 55])
ACC_TYPES = ('stock', 'STOCK', 'credit', 'CREDIT')


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
        out[name] = val
    return out


def _resolve_trade_fn(ContextInfo):
    try:
        import builtins as bi
    except ImportError:
        import __builtin__ as bi

    candidates = []
    for n in ('get_trade_detail_data', 'get_trade_detail'):
        for src, obj in (
            ('builtins', bi),
            ('globals', globals()),
            ('ContextInfo', ContextInfo),
        ):
            fn = obj.get(n) if isinstance(obj, dict) else getattr(obj, n, None)
            if callable(fn):
                candidates.append((fn, '%s.%s' % (src, n)))
    if not candidates:
        return None, None
    return candidates[0]


def _try_get_trade_detail(fn, account, acc_type, data_name):
    try:
        data = fn(account, acc_type, data_name)
        return data, None
    except Exception as e:
        return None, '%s %s' % (type(e).__name__, e)


def _query_all(fn, account, names):
    last = None
    last_meta = (None, None)
    for acc_type in ACC_TYPES:
        for name in names:
            data, err = _try_get_trade_detail(fn, account, acc_type, name)
            if err:
                print('skip', acc_type, name, '->', err)
                continue
            n = len(data) if data is not None and hasattr(data, '__len__') else -1
            print('hit', acc_type, name, 'count=', n)
            if data:
                return data, acc_type, name
            last = data
            last_meta = (acc_type, name)
    return last, last_meta[0], last_meta[1]


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


def _g(row, *keys):
    for key in keys:
        if hasattr(row, key):
            val = getattr(row, key)
            if val is not None and val != '':
                return val
    return ''


def _side_text(row):
    raw = _g(row, 'm_nDirection', 'm_nOffsetFlag')
    try:
        code = int(raw)
    except Exception:
        return str(raw)
    if code in (48, 0):
        return '买'
    if code in (49, 1):
        return '卖'
    return str(code)


def _dump_list(title, rows, limit=30):
    print('====', title, '====')
    if not rows:
        print('(empty)')
        return
    n = 0
    for row in rows:
        print(_public_attrs(row))
        n += 1
        if n >= limit:
            print('... truncated')
            break


def _print_deals(title, rows):
    print('====', title, '====')
    if not rows:
        print('(empty)')
        return
    i = 0
    for row in rows:
        i += 1
        price = _g(row, 'm_dPrice', 'm_dAveragePrice', 'm_dTradePrice')
        volume = _g(row, 'm_nVolume', 'm_nTradeVolume', 'm_nVolumeTraded')
        t = _g(row, 'm_strTradeTime', 'm_strInsertTime', 'm_strOrderTime', 'm_strTime')
        d = _g(row, 'm_strTradeDate', 'm_strInsertDate', 'm_strDate')
        tid = _g(row, 'm_strTradeID', 'm_strDealID', 'm_strExecID')
        oid = _g(row, 'm_strOrderSysID', 'm_strOrderRef', 'm_strOrderID')
        code = _code_of(row)
        print('%d %s %s price=%s qty=%s date=%s time=%s trade_id=%s order_id=%s' % (
            i, code, _side_text(row), price, volume, d, t, tid, oid))
        print('   fields:', _public_attrs(row))


def _is_open_order(row):
    status = getattr(row, 'm_nOrderStatus', None)
    try:
        status = int(status)
    except Exception:
        return False
    return status in OPEN_STATUS


def init(ContextInfo):
    ContextInfo.printed = False
    ContextInfo.set_universe([STOCK_UNIVERSE])

    if ACCOUNT and hasattr(ContextInfo, 'set_account'):
        try:
            ContextInfo.set_account(ACCOUNT)
            print('set_account ok')
        except Exception as e:
            print('set_account error:', type(e).__name__, e)
    else:
        print('no set_account; fill ACCOUNT and run live')

    names = [n for n in dir(ContextInfo) if 'order' in n.lower() or 'deal' in n.lower()
             or 'trade' in n.lower() or 'account' in n.lower() or 'entrust' in n.lower()]
    print('ContextInfo trade-related:', names)


def handlebar(ContextInfo):
    if ContextInfo.printed:
        return
    ContextInfo.printed = True

    print('tips: 若下面成交仍是空，说明还在回测。请到顶部「交易」里启动策略，不要点回测。')

    fn, fn_src = _resolve_trade_fn(ContextInfo)
    print('trade fn:', fn_src, fn)
    if fn is None:
        print('找不到 get_trade_detail_data。请把这段日志发回。')
        return

    acc = ACCOUNT
    if not acc:
        print('ACCOUNT 为空')
        return

    print('query account:', acc)
    orders, _, _ = _query_all(fn, acc, ['order', 'ORDER', 'Order'])
    deals, _, _ = _query_all(fn, acc, ['deal', 'DEAL', 'Deal', 'trade', 'TRADE'])

    stock_orders = _filter_stock(orders)
    stock_deals = _filter_stock(deals)
    open_orders = [o for o in (stock_orders or []) if _is_open_order(o)]

    print('全部委托笔数:', 0 if not orders else len(orders))
    print('全部成交笔数:', 0 if not deals else len(deals))
    print(STOCK_UNIVERSE, '委托笔数:', len(stock_orders))
    print(STOCK_UNIVERSE, '挂盘笔数:', len(open_orders))
    print(STOCK_UNIVERSE, '成交笔数:', len(stock_deals))

    _dump_list(STOCK_UNIVERSE + ' 挂盘', open_orders)
    _dump_list(STOCK_UNIVERSE + ' 委托', stock_orders)
    _print_deals(STOCK_UNIVERSE + ' 成交明细', stock_deals)

    if (not orders) and (not deals):
        print('结论: 接口空。今天账户里有成交的话，几乎肯定是回测模式，请改实盘启动。')
