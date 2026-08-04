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

/**
 * Combines documentation, verification, and screenshot capture into a
 * single atomic operation so that scenario docs and baseline images never
 * drift out of sync with the test steps that produced them.
 */
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
    // 1. Run verifications first so failures point at real UI state.
    for (const verification of options.verifications) {
      await verification.check();
    }

    // 2. Generate a stable, ordered filename. Never manage this by hand.
    const paddedIndex = String(this.stepCount++).padStart(3, '0');
    const filename = `${paddedIndex}-${id.replace(/_/g, '-')}`;

    // 3. Capture & verify with zero-pixel tolerance against the committed
    // baseline in `screenshots/{filename}.png`.
    await expect(this.page).toHaveScreenshot(`${filename}.png`);

    // 4. Record for documentation generation.
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
