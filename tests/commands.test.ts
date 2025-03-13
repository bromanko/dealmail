import { describe, it, expect } from 'vitest';
import { getEmailsCommand } from '../src/commands/get-emails.js';
import { getImageCommand } from '../src/commands/get-image.js';
import { extractCommand } from '../src/commands/extract.js';

describe('CLI Commands', () => {
  describe('get-emails command', () => {
    it('should be properly configured', () => {
      expect(getEmailsCommand.name).toBe('get-emails');
      expect(getEmailsCommand.description).toContain('Fetch emails');
      expect(getEmailsCommand).toHaveProperty('handler');
    });
  });

  describe('get-image command', () => {
    it('should be properly configured', () => {
      expect(getImageCommand.name).toBe('get-image');
      expect(getImageCommand.description).toContain('Generate');
      expect(getImageCommand).toHaveProperty('handler');
    });
  });

  describe('extract command', () => {
    it('should be properly configured', () => {
      expect(extractCommand.name).toBe('extract');
      expect(extractCommand.description).toContain('Extract');
      expect(extractCommand).toHaveProperty('handler');
    });
  });
});