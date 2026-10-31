import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load(slug):
    spec = importlib.util.spec_from_file_location(slug, ROOT / 'skills' / slug / 'scripts' / 'prepare.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.prepare

def line(quantity='10', currency='CNY', unit='件'):
    return dict(sku='S1', quantity=quantity, unit=unit, currency=currency, unitPrice='2.50', source='B:row1')

class CommercialSkills(unittest.TestCase):
    def test_stale_quantity(self):
        out = load('tiancheng-rfq-change-review')({'A':[line()], 'B':[line('20')], 'Q':[line()]})
        self.assertEqual(out['findings'][0]['code'], 'stale')
        self.assertEqual(out['findings'][0]['field'], 'quantity')
        self.assertEqual(out['status'], 'needs-review')
        self.assertEqual(out['findings'][0]['latest'], '20')

    def test_decimal_equivalence(self):
        self.assertEqual(load('tiancheng-rfq-change-review')({'A':[line('10.0')], 'B':[line()], 'Q':[line()]})['findings'], [])

    def test_missing_currency_blocks(self):
        out = load('tiancheng-rfq-change-review')({'A':[], 'B':[line(currency='')], 'Q':[line()]})
        self.assertTrue(any(x['code']=='missing' for x in out['findings']))

    def test_duplicate_not_silently_merged(self):
        out = load('tiancheng-rfq-change-review')({'A':[], 'B':[line(),line()], 'Q':[line()]})
        self.assertTrue(any(x['code']=='duplicate-sku' for x in out['findings']))

    def test_units_not_converted(self):
        out = load('tiancheng-rfq-change-review')({'A':[], 'B':[line(unit='箱')], 'Q':[line()]})
        self.assertTrue(any(x.get('field')=='unit' for x in out['findings']))

    def test_unknown_quote_line(self):
        out = load('tiancheng-rfq-change-review')({'A':[], 'B':[], 'Q':[line()]})
        self.assertEqual(out['findings'][0]['code'], 'extra-quote-line')

    def test_malformed_rejected(self):
        with self.assertRaises(ValueError):load('tiancheng-rfq-change-review')({'A':[], 'B':{}, 'Q':[]})

    def test_non_finite_rejected_as_finding(self):
        out = load('tiancheng-rfq-change-review')({'A':[], 'B':[line('NaN')], 'Q':[line()]})
        self.assertTrue(any(x['code']=='invalid-number' for x in out['findings']))

    def test_extreme_exponent_rejected(self):
        out = load('tiancheng-rfq-change-review')({'A':[], 'B':[line('1e999999')], 'Q':[line()]})
        self.assertTrue(any(x['code']=='invalid-number' for x in out['findings']))

    def brief(self):
        return dict(product='通勤袋', productReference='自有商品图1', replace='袋身', preserve=['提手','Logo'], materials=[{'name':'帆布','reference':'样本图2'}])

    def test_material_brief_is_not_generation(self):
        out=load('tiancheng-material-selection-brief')(self.brief())
        self.assertFalse(out['modelCalled'])
        self.assertIn('Logo',out['proposals'][0]['prompt'])
        self.assertEqual(out['stage'],'brief-only')

    def test_missing_photo_rejected(self):
        b=self.brief();del b['productReference']
        with self.assertRaises(ValueError):load('tiancheng-material-selection-brief')(b)

    def test_missing_material_reference_rejected(self):
        b=self.brief();b['materials'][0]['reference']=''
        with self.assertRaises(ValueError):load('tiancheng-material-selection-brief')(b)

    def test_not_mutating_input(self):
        import copy
        b=self.brief();original=copy.deepcopy(b)
        load('tiancheng-material-selection-brief')(b)
        self.assertEqual(b,original)

if __name__=='__main__':unittest.main()
