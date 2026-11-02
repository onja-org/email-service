import { describe, expect, it } from 'vitest';
import { renderTemplate, validateTemplateSource } from '../src/services/templates.js';

describe('renderTemplate', () => {
  it('renders subject, html and text with data', () => {
    const out = renderTemplate(
      { subject: 'Hi {{name}}', html: '<p>Hello {{name}}</p>', text: 'Hello {{name}}' },
      { name: 'Ada' },
    );
    expect(out).toEqual({ subject: 'Hi Ada', html: '<p>Hello Ada</p>', text: 'Hello Ada' });
  });

  it('escapes HTML in html body but not in subject/text', () => {
    const out = renderTemplate(
      { subject: '{{v}}', html: '{{v}} {{{v}}}', text: '{{v}}' },
      { v: '<b>&</b>' },
    );
    expect(out.subject).toBe('<b>&</b>');
    expect(out.text).toBe('<b>&</b>');
    expect(out.html).toBe('&lt;b&gt;&amp;&lt;/b&gt; <b>&</b>');
  });

  it('leaves missing variables empty and omits absent bodies', () => {
    const out = renderTemplate({ subject: 'x {{missing}} y', html: null, text: 'ok' }, {});
    expect(out.subject).toBe('x  y');
    expect(out.html).toBeUndefined();
    expect(out.text).toBe('ok');
  });

  it('supports helpers like #if and #each', () => {
    const out = renderTemplate(
      { subject: 's', html: null, text: '{{#if items}}{{#each items}}- {{this}}\n{{/each}}{{else}}none{{/if}}' },
      { items: ['a', 'b'] },
    );
    expect(out.text).toBe('- a\n- b\n');
  });
});

describe('validateTemplateSource', () => {
  it('throws on syntax errors', () => {
    expect(() => validateTemplateSource({ subject: '{{#if x}}', html: null, text: null })).toThrow();
    expect(() => validateTemplateSource({ subject: 'ok', html: '{{name}}', text: null })).not.toThrow();
  });
});
