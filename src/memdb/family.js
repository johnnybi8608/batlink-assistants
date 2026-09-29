// Family roster -> text inserted into assistant prompts (fetched fresh on every wake-up, so edits in the database
// show up immediately). The prompt text is Chinese because the bundled assistants have Chinese personas.
import { PORT, localFetch } from '../local.js';

const port = PORT;
// Generic forms of address that only help database lookups; they are not listed in the roster
const GENERIC = new Set(['我', '主人', '机主', '妻子', '丈夫', '老婆', '老公', '媳妇', '配偶', '女儿', '儿子', '孩子']);
const PERSPECTIVE = { owner: '主人一家' };

/**
 * @param {string} self  whose point of view the relations are written from: 'owner' (default) or, for an assistant
 *   serving a family member, that person's name / alias / entity id (the waker's memSelf)
 */
export async function familyRoster(self = 'owner') {
  try {
    const res = await localFetch(`/mem/family?self=${encodeURIComponent(self)}`, { signal: AbortSignal.timeout(5000) });
    const { family } = await res.json();
    if (!family?.length) return '';
    const lines = family.map((p) => {
      const names = p.aliases.filter((a) => !GENERIC.has(a));
      return `- ${p.name}(${p.relation})${names.length ? `:${names.join(' / ')}` : ''}${p.birthday ? `,生日 ${p.birthday}` : ''}${p.about ? `,${p.about}` : ''}`;
    });
    return `【${PERSPECTIVE[self] ?? '这一家人'}(看文件、图片时按这些名字对人,中文名、英文名、小名都算)】\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/** Rule for filing information found in documents and images (shared by DM assistants and persona assistants) */
export const DOCUMENT_RULE = `看任何文件、图片时(诊断证明、化验单、处方、病历、体检报告、学校通知、证件等),上面的名字对得上主人一家的某个人(中文名、英文名、小名都算),看完就把信息记到那个人名下:
  · 医疗类:用 mem_health_report 记一次就诊或检查(person 填那个人,taken_on、医院、诊断写进 summary,有指标就一项一项写进 results),file_path 填原图路径把原件存上。
  · 药:只有对方说在吃了、开始吃了,才用 mem_medication 记成正在用的药;光是开了药不算。
  · 其他重要信息(证件到期日、学校的重要日子等):用 mem_remember 记成那个人的事实。
  · 证件号码、银行卡号这类号码不记。
  · 名字对不上或看不清,先问一句"这是谁的",问清楚再记,不要乱记到主人名下。
  · 记好了不用特意汇报,自然地提一句就行。`;
