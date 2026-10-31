"""Prepare explicit product/material references. No model calls or file writes."""
import json
import sys

def text(value, field):
    if not isinstance(value,str) or not value.strip() or len(value)>1000:
        raise ValueError(field+'必须为1至1000字符的明确文字')
    return value.strip()

def prepare(data):
    if not isinstance(data,dict):raise ValueError('输入必须为JSON对象')
    product=text(data.get('product'),'product')
    product_ref=text(data.get('productReference'),'productReference')
    replace=text(data.get('replace'),'replace')
    keep=data.get('preserve')
    if not isinstance(keep,list) or not 1<=len(keep)<=20:raise ValueError('preserve需要1至20项保留要求')
    keep=[text(x,'preserve') for x in keep]
    materials=data.get('materials')
    if not isinstance(materials,list) or not 1<=len(materials)<=6:raise ValueError('materials需要1至6份有参考图的材质')
    proposals=[]
    names=set()
    for m in materials:
        if not isinstance(m,dict):raise ValueError('材质必须为对象')
        name=text(m.get('name'),'material.name')
        reference=text(m.get('reference'),'material.reference')
        if name in names:raise ValueError('材质名称重复，请区分样本编号')
        names.add(name)
        proposals.append(dict(material=name,productReference=product_ref,materialReference=reference,
            prompt=f'图1为{product}商品原图，图2为{name}材质参考。仅替换{replace}。保留'+
            '、'.join(keep)+'；保持轮廓、结构、比例、透视与原有文字，不添加品牌或新文字。纹理随表面透视。',
            checks=['结构和尺寸比例','Logo与文字','纹理方向与尺度','保留区域有无变动','实物工艺另由厂家确认']))
    return dict(schema='material-selection-brief-v1',stage='brief-only',modelCalled=False,proposals=proposals,
        acceptance='待真实生成后逐图人工核验；提案不证明视觉效果或可制造性',
        limits='仅整理提供的事实与引用，不读图、不抓取引用、不生图、不上传、不报价。')

if __name__=='__main__':
    try:
        if len(sys.argv)!=2:raise ValueError('用法：python3 prepare.py input.json')
        with open(sys.argv[1],encoding='utf-8') as f:data=json.load(f)
        print(json.dumps(prepare(data),ensure_ascii=False,indent=2))
    except (ValueError,OSError) as error:
        print(str(error),file=sys.stderr);sys.exit(2)
