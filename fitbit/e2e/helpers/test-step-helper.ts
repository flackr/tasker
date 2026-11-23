import { type Page, type TestInfo, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Verification {
  spec: string;
  check: () => Promise<void>;
}

export interface StepOptions {
  description: string;
  verifications: Verification[];
}

interface DocStep {
  title: string;
  image: string;
  specs: string[];
}

export class TestStepHelper {
  private stepCount = 0;
  private steps: DocStep[] = [];
  private title = '';
  private description = '';

  constructor(private page: Page, private testInfo: TestInfo) {}

  setMetadata(title: string, description: string) {
    this.title = title;
    this.description = description;
  }

  async step(id: string, options: StepOptions) {
    for (const verification of options.verifications) {
      await verification.check();
    }

    const paddedIndex = String(this.stepCount++).padStart(3, '0');
    const filename = `${paddedIndex}-${id.replace(/_/g, '-')}`;

    await expect(this.page).toHaveScreenshot(`${filename}.png`);

    this.steps.push({
      title: options.description,
      image: `./screenshots/${filename}.png`,
      specs: options.verifications.map((v) => v.spec),
    });
  }

  generateDocs() {
    const docPath = path.join(path.dirname(this.testInfo.file), 'README.md');
    let content = `# Test: ${this.title || this.testInfo.title}\n\n`;
    if (this.description) {
      content += `${this.description}\n\n`;
    }

    for (const step of this.steps) {
      content += `## ${step.title}\n\n`;
      content += `![${step.title}](${step.image})\n\n`;
      content += `**Verifications:**\n`;
      for (const spec of step.specs) {
        content += `- [x] ${spec}\n`;
      }
      content += `\n---\n\n`;
    }

    fs.writeFileSync(docPath, content);
  }
}
