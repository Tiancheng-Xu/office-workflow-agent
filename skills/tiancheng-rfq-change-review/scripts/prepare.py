"""Read one explicit normalized JSON input; emit findings. No network or writes."""
import json
import sys
from decimal import Decimal, InvalidOperation

FIELDS = ('quantity', 'unit', 'currency', 'unitPrice')

def prepare(data):
    if not isinstance(data, dict):
        raise ValueError('输入必须为包含A/B/Q的JSON对象')
    findings, tables = [], {}
    for role in ('A','B','Q'):
        rows = data.get(role)
        if not isinstance(rows, list) or len(rows)>200:
            raise ValueError('A/B/Q必须各为不超过200行的数组')
        tables[role] = {}
        for index, row in enumerate(rows, 1):
            if not isinstance(row, dict):
                raise ValueError('每行必须为对象')
            sku = row.get('sku')
            if not isinstance(sku, str) or not sku.strip():
                findings.append(dict(code='missing',role=role,row=index,field='sku'))
                continue
            sku = sku.strip()
            if sku in tables[role]:
                findings.append(dict(code='duplicate-sku',role=role,sku=sku,row=index))
                # Remove ambiguous matches instead of choosing the last row.
                tables[role][sku] = None
                continue
            normalized = {}
            for field in (*FIELDS,'source'):
                value = row.get(field)
                if not isinstance(value,str) or not value.strip():
                    findings.append(dict(code='missing',role=role,sku=sku,row=index,field=field))
                    continue
                value = value.strip()
                if field in ('quantity','unitPrice'):
                    try:
                        number = Decimal(value)
                        if not number.is_finite() or number<0 or (field=='quantity' and number==0) or len(value)>64:
                            raise InvalidOperation
                        if number.adjusted()>15 or number.as_tuple().exponent < -9:
                            raise InvalidOperation
                        value = format(number.normalize(),'f')
                    except (InvalidOperation, ValueError):
                        findings.append(dict(code='invalid-number',role=role,sku=sku,row=index,field=field))
                        continue
                normalized[field] = value
            tables[role][sku] = normalized
    for sku in sorted(tables['B'].keys() | tables['Q'].keys()):
        current, quote, old = tables['B'].get(sku), tables['Q'].get(sku), tables['A'].get(sku)
        if sku not in tables['B']:
            findings.append(dict(code='extra-quote-line',sku=sku));continue
        if sku not in tables['Q']:
            findings.append(dict(code='missing-quote-line',sku=sku));continue
        if current is None or quote is None:
            continue
        for field in FIELDS:
            if field not in current or field not in quote:
                continue
            if current[field] != quote[field]:
                findings.append(dict(code='stale' if old and old.get(field)==quote[field] else 'mismatch',
                    sku=sku,field=field,latest=current[field],quoted=quote[field],
                    latestSource=current.get('source'),quoteSource=quote.get('source')))
    return dict(schema='rfq-change-review-v1',status='needs-review' if findings else 'no-difference-in-supplied-fields',
        findings=findings,approval='not-approved',originalDocumentsVerified=False,
        limits='仅核对用户规范化字段；不识别原件/OCR，不换算单位/币种/税额，不批准或发送报价。')

if __name__=='__main__':
    try:
        if len(sys.argv)!=2:raise ValueError('用法：python3 prepare.py input.json')
        with open(sys.argv[1],encoding='utf-8') as f:data=json.load(f)
        print(json.dumps(prepare(data),ensure_ascii=False,indent=2,allow_nan=False))
    except (ValueError,OSError) as error:
        print(str(error),file=sys.stderr);sys.exit(2)
