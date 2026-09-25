import { emptyStore } from '../src/lib/store.js';

/** 测试通用初始数据：T1(10座/2童椅)、T2(8座/4童椅)、G01..G08 空回复宾客 */
export function freshSetup() {
  const s = emptyStore();
  s.tables = {
    T1: { id: 'T1', name: '主桌', capacity: 10, childCapacity: 2 },
    T2: { id: 'T2', name: '亲友桌', capacity: 8, childCapacity: 4 },
  };
  s.tableOrder = ['T1', 'T2'];
  const names = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十'];
  names.forEach((name, i) => {
    const id = `G0${i + 1}`;
    s.guests[id] = { id, name, partySize: 1, children: 0, childSeatNeeded: false, rsvp: null };
  });
  return s;
}
