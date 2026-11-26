import type { DockerfileRule } from '../../core/rule.js';
import { IMAGE_RULES } from './images.js';
import { INSTRUCTION_RULES } from './instructions.js';
import { PACKAGE_RULES } from './packages.js';
import { SECURITY_RULES } from './security.js';

export const DOCKERFILE_RULES: DockerfileRule[] = [
  ...IMAGE_RULES,
  ...SECURITY_RULES,
  ...PACKAGE_RULES,
  ...INSTRUCTION_RULES,
].sort((a, b) => a.id.localeCompare(b.id));
