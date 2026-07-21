import type { CommandResult, EnclosureParameters } from './types';

const NUMBER = '(\\d+(?:\\.\\d+)?)';

const rules: Array<{
  key: keyof EnclosureParameters;
  label: string;
  patterns: RegExp[];
}> = [
  { key: 'cornerRadius', label: '外壳圆角', patterns: [new RegExp(`圆角(?:半径)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'edgeChamfer', label: '边缘倒角', patterns: [new RegExp(`倒角(?:宽度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'wallThickness', label: '外壳壁厚', patterns: [new RegExp(`壁厚(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'baseThickness', label: '底板厚度', patterns: [new RegExp(`底板(?:厚度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'clearanceXY', label: '水平装配间隙', patterns: [new RegExp(`(?:水平|XY)?间隙(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'usbPortWidth', label: 'USB 开孔宽度', patterns: [new RegExp(`USB\\s*(?:接口)?\\s*(?:开孔)?\\s*宽(?:度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'usbPortHeight', label: 'USB 开孔高度', patterns: [
    new RegExp(`USB\\s*(?:接口)?\\s*(?:开孔)?\\s*高(?:度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i'),
    new RegExp(`USB[\\s\\S]*?高(?:度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')
  ] },
  { key: 'boardLength', label: 'PCB 长度', patterns: [new RegExp(`(?:PCB|开发板|板子)(?:的)?长(?:度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] },
  { key: 'boardWidth', label: 'PCB 宽度', patterns: [new RegExp(`(?:PCB|开发板|板子)(?:的)?宽(?:度)?(?:改成|设为|设置为|到|为)?\\s*${NUMBER}`, 'i')] }
];

/** 在 Codex 不可用时解析一小部分确定性的中文建模指令。 */
export function analyzeModelCommand(command: string): CommandResult {
  const parameters: Partial<EnclosureParameters> = {};
  const changes: string[] = [];

  rules.forEach((rule) => {
    const match = rule.patterns.map((pattern) => command.match(pattern)).find(Boolean);
    if (!match) return;

    const value = Number(match[1]);
    parameters[rule.key] = value;
    changes.push(`${rule.label}设为 ${value} 毫米`);
  });

  if (changes.length === 0) {
    return {
      parameters,
      summary: '当前本地命令解析器没有识别到可执行尺寸。可以尝试“圆角改成 6 毫米”或“壁厚设为 2.4 毫米”。'
    };
  }

  return {
    parameters,
    summary: `${changes.join('，')}。已重新计算实体布尔结果并创建新版本。`
  };
}
