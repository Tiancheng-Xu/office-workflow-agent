import {z} from 'zod';
// These are measurement units, not a closed product catalogue. Packaging counts
// remain packaging counts: no unprovided pieces-per-package conversion.
export const units=['件','台','把','个','套','张','包','箱','盒','打','支','本','卷','块','瓶','袋','组','根','只','枚'] as const;
export type Unit=typeof units[number];
export const itemSchema=z.string().trim().min(1).max(64)
 .regex(/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u)
 .refine(value=>!/付款|支付|退款|转账|授权|权限|脚本|代码|删除|取消|不要|需要|用于|用来|作为|送到|送至|送给|放在|以及|还有|并且|[和与或]/u.test(value),'请填写一个明确的物品名称和规格。');
export const unitSchema=z.enum(units);
export function quantityLabel(value:{quantity:number;unit?:Unit}):string{return `${value.quantity} ${value.unit??'件'}`;}
