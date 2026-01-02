/*
 * Copyright (C) 2023-2025  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {log} from '../core/log.js';

export class DisplayAi {
    /**
     * @param {import('./display.js').Display} display
     */
    constructor(display) {
        /** @type {import('./display.js').Display} */
        this._display = display;

        /** @type {?HTMLElement} */
        this._root = null;
        /** @type {?HTMLElement} */
        this._content = null;
        /** @type {?HTMLElement} */
        this._status = null;
        /** @type {?HTMLButtonElement} */
        this._button = null;

        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();

        /** @type {number} */
        this._requestId = 0;
        /** @type {{mode: 'auto'|'manual'}|null} */
        this._settings = null;

        /** @type {{word: string, context: string}|null} */
        this._pendingInput = null;
    }

    /** */
    prepare() {
        this._root = document.querySelector('#ai-explanation');
        if (this._root === null) { return; }

        this._content = this._root.querySelector('#ai-explanation-content');
        this._status = this._root.querySelector('#ai-explanation-status');
        this._button = /** @type {?HTMLButtonElement} */ (this._root.querySelector('#ai-explain-button'));

        this._display.on('contentClear', this._onContentClear.bind(this));
        this._display.on('contentUpdateStart', this._onContentUpdateStart.bind(this));

        if (this._button !== null) {
            this._eventListeners.addEventListener(this._button, 'click', this._onButtonClick.bind(this));
        }
    }

    // Private

    /** */
    _onContentClear() {
        this._requestId += 1;
        this._pendingInput = null;
        this._setVisible(false);
        this._setButtonVisible(false);
        this._setStatusText('');
        this._setContentText('');
    }

    /**
     * @param {import('display').EventArgument<'contentUpdateStart'>} details
     */
    async _onContentUpdateStart({query}) {
        this._requestId += 1;
        this._pendingInput = null;

        if (!this._isShiftLookup()) {
            this._setVisible(false);
            return;
        }

        const requestId = this._requestId;
        try {
            const settings = await this._display.application.api.aiGetSettings();
            if (requestId !== this._requestId) { return; }

            this._settings = settings;
        } catch (e) {
            this._settings = null;
            this._setVisible(true);
            this._setButtonVisible(false);
            this._setStatusText('AI settings unavailable.');
            this._setContentText('');
            log.error(e);
            return;
        }

        const word = typeof query === 'string' ? query : '';
        const context = this._getSentenceText();
        this._pendingInput = {word, context};

        this._setVisible(true);

        if (this._settings?.mode === 'manual') {
            this._setButtonVisible(true);
            this._setStatusText('Click AI to explain.');
            this._setContentText('');
            return;
        }

        this._setButtonVisible(false);
        void this._requestExplain(word, context);
    }

    /** */
    _onButtonClick() {
        if (!this._isShiftLookup()) { return; }
        if (this._pendingInput === null) { return; }
        void this._requestExplain(this._pendingInput.word, this._pendingInput.context);
    }

    /**
     * @param {string} word
     * @param {string} context
     */
    async _requestExplain(word, context) {
        this._requestId += 1;
        const requestId = this._requestId;

        this._setVisible(true);
        this._setStatusText('AI is thinking…');
        this._setContentText('');

        try {
            const settings = this._settings ?? await this._display.application.api.aiGetSettings();
            if (requestId !== this._requestId) { return; }

            const apiUrl = (typeof settings.apiUrl === 'string' ? settings.apiUrl.trim() : '');
            if (apiUrl.length === 0) { throw new Error('AI API URL not configured'); }

            const prompt = this._buildPrompt(settings.prompt, word, context);
            const resultText = await this._fetchCompletionStreaming({
                apiUrl,
                apiKey: settings.apiKey,
                model: settings.model,
                prompt,
                onText: (partial) => {
                    if (requestId !== this._requestId) { return; }
                    this._setContentText(partial);
                    const parsed = this._tryParseJson(partial);
                    if (parsed !== null) {
                        this._setStatusText('');
                        this._setContentRendered(parsed);
                    }
                },
            });

            if (requestId !== this._requestId) { return; }

            const parsed = this._tryParseJson(resultText);
            this._setStatusText('');
            if (parsed !== null) {
                this._setContentRendered(parsed);
            } else {
                this._setContentText(resultText);
            }
        } catch (e) {
            if (requestId !== this._requestId) { return; }
            this._setStatusText('AI request failed.');
            this._setContentText(e instanceof Error ? e.message : String(e));
            log.error(e);
        }
    }

    /**
     * @param {string} style
     * @param {string} word
     * @param {string} context
     * @returns {string}
     */
    _buildPrompt(style, word, context) {
        const style2 = typeof style === 'string' ? style.trim() : '';
        const styleBlock = (style2.length > 0 ? `\n\nStyle requirements:\n${style2}\n` : '');

        return (
            'You are a language-learning assistant.\n' +
            'Return a single JSON object and NOTHING else (no markdown, no code fences, no comments).\n' +
            'The JSON must be valid, UTF-8, and use double quotes.\n' +
            'Output schema:\n' +
            '{\n' +
            '  "title": string,\n' +
            '  "word": string,\n' +
            '  "meaning": string,\n' +
            '  "meaning_in_context": string,\n' +
            '  "usage": string,\n' +
            '  "examples": [{"text": string, "explain": string}]\n' +
            '}\n' +
            styleBlock +
            '\nInput:\n' +
            `word: ${word}\n` +
            `context: ${context}\n`
        );
    }

    /**
     * @param {string} text
     * @returns {unknown|null}
     */
    _tryParseJson(text) {
        if (typeof text !== 'string') { return null; }
        const trimmed = text.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) { return null; }
        try {
            // eslint-disable-next-line no-restricted-syntax
            return JSON.parse(trimmed);
        } catch {
            return null;
        }
    }

    /**
     * @param {{
     *   apiUrl: string,
     *   apiKey: string,
     *   model: string,
     *   prompt: string,
     *   onText: (text: string) => void
     * }} details
     * @returns {Promise<string>}
     */
    async _fetchCompletionStreaming({apiUrl, apiKey, model, prompt, onText}) {
        const headers = {'Content-Type': 'application/json'};
        if (typeof apiKey === 'string' && apiKey.length > 0) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        /** @type {{model?: string, messages: {role: string, content: string}[], stream: boolean, response_format: {type: string}}} */
        const body = {
            messages: [{role: 'user', content: prompt}],
            stream: true,
            response_format: {type: 'json_object'},
        };
        if (typeof model === 'string' && model.length > 0) {
            body.model = model;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`AI request failed (${response.status}): ${text.slice(0, 500)}`);
            }

            if (response.body === null) {
                const data = await response.text();
                onText(data);
                return data;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');

            let buffer = '';
            let result = '';

            while (true) {
                const {value, done} = await reader.read();
                if (done) { break; }
                buffer += decoder.decode(value, {stream: true});

                while (true) {
                    const lineEnd = buffer.indexOf('\n');
                    if (lineEnd < 0) { break; }
                    const line = buffer.slice(0, lineEnd).trimEnd();
                    buffer = buffer.slice(lineEnd + 1);

                    if (!line.startsWith('data:')) { continue; }
                    const dataStr = line.slice(5).trim();
                    if (dataStr === '[DONE]') {
                        onText(result);
                        return result;
                    }

                    /** @type {unknown} */
                    let data;
                    try {
                        // eslint-disable-next-line no-restricted-syntax
                        data = JSON.parse(dataStr);
                    } catch {
                        continue;
                    }

                    const delta = this._getStreamDeltaContent(data);
                    if (delta.length > 0) {
                        result += delta;
                        onText(result);
                    }
                }
            }

            onText(result.length > 0 ? result : buffer.trim());
            return (result.length > 0 ? result : buffer.trim());
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') {
                throw new Error('AI request timed out');
            }
            throw e;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * @param {unknown} data
     * @returns {string}
     */
    _getStreamDeltaContent(data) {
        if (typeof data !== 'object' || data === null) { return ''; }
        /** @type {unknown} */
        const choices = /** @type {{choices?: unknown}} */ (data).choices;
        if (!Array.isArray(choices) || choices.length === 0) { return ''; }
        const choice0 = choices[0];
        if (typeof choice0 !== 'object' || choice0 === null) { return ''; }

        /** @type {unknown} */
        const delta = /** @type {{delta?: unknown}} */ (choice0).delta;
        if (typeof delta === 'object' && delta !== null) {
            /** @type {unknown} */
            const content = /** @type {{content?: unknown}} */ (delta).content;
            if (typeof content === 'string') { return content; }
        }

        /** @type {unknown} */
        const message = /** @type {{message?: unknown}} */ (choice0).message;
        if (typeof message === 'object' && message !== null) {
            /** @type {unknown} */
            const content = /** @type {{content?: unknown}} */ (message).content;
            if (typeof content === 'string') { return content; }
        }

        return '';
    }

    /**
     * @returns {boolean}
     */
    _isShiftLookup() {
        const state = this._display.history.state;
        const optionsContext = state?.optionsContext;
        const modifierKeys = optionsContext?.modifierKeys;
        return Array.isArray(modifierKeys) && modifierKeys.includes('shift');
    }

    /**
     * @returns {string}
     */
    _getSentenceText() {
        const state = this._display.history.state;
        const sentence = state?.sentence;
        return (typeof sentence?.text === 'string' ? sentence.text : '');
    }

    /**
     * @param {boolean} visible
     */
    _setVisible(visible) {
        if (this._root === null) { return; }
        this._root.hidden = !visible;
    }

    /**
     * @param {boolean} visible
     */
    _setButtonVisible(visible) {
        if (this._button === null) { return; }
        this._button.hidden = !visible;
    }

    /**
     * @param {string} value
     */
    _setStatusText(value) {
        if (this._status === null) { return; }
        this._status.textContent = value;
        this._status.hidden = (value.length === 0);
    }

    /**
     * @param {string} value
     */
    _setContentText(value) {
        if (this._content === null) { return; }
        this._content.textContent = value;
    }

    /**
     * @param {unknown} value
     */
    _setContentRendered(value) {
        if (this._content === null) { return; }
        this._content.textContent = '';

        if (typeof value !== 'object' || value === null) {
            this._content.textContent = String(value);
            return;
        }

        const data = /** @type {Record<string, unknown>} */ (value);

        const title = (typeof data.title === 'string' ? data.title : '');
        const word = (typeof data.word === 'string' ? data.word : '');
        const meaning = (typeof data.meaning === 'string' ? data.meaning : '');
        const meaningInContext = (typeof data.meaning_in_context === 'string' ? data.meaning_in_context : '');
        const usage = (typeof data.usage === 'string' ? data.usage : '');
        const examples = (Array.isArray(data.examples) ? data.examples : []);

        const header = document.createElement('div');
        header.className = 'ai-explanation-render-header';

        const titleNode = document.createElement('div');
        titleNode.className = 'ai-explanation-render-title';
        titleNode.textContent = title.length > 0 ? title : (word.length > 0 ? word : 'AI');
        header.appendChild(titleNode);

        if (word.length > 0) {
            const badge = document.createElement('div');
            badge.className = 'ai-explanation-render-badge';
            badge.textContent = word;
            header.appendChild(badge);
        }

        this._content.appendChild(header);

        const addSection = (sectionTitle, bodyText) => {
            if (typeof bodyText !== 'string' || bodyText.trim().length === 0) { return; }
            const section = document.createElement('div');
            section.className = 'ai-explanation-section';

            const h = document.createElement('div');
            h.className = 'ai-explanation-section-title';
            h.textContent = sectionTitle;
            section.appendChild(h);

            const p = document.createElement('div');
            p.className = 'ai-explanation-section-body';
            p.textContent = bodyText;
            section.appendChild(p);

            this._content.appendChild(section);
        };

        addSection('Meaning', meaning);
        addSection('In context', meaningInContext);
        addSection('Usage', usage);

        if (examples.length > 0) {
            const section = document.createElement('div');
            section.className = 'ai-explanation-section';

            const h = document.createElement('div');
            h.className = 'ai-explanation-section-title';
            h.textContent = 'Examples';
            section.appendChild(h);

            const list = document.createElement('div');
            list.className = 'ai-explanation-examples';
            for (const example of examples) {
                if (typeof example !== 'object' || example === null) { continue; }
                const exampleObj = /** @type {Record<string, unknown>} */ (example);
                const text = (typeof exampleObj.text === 'string' ? exampleObj.text : '');
                const explain = (typeof exampleObj.explain === 'string' ? exampleObj.explain : '');
                if (text.length === 0 && explain.length === 0) { continue; }

                const item = document.createElement('div');
                item.className = 'ai-explanation-example';

                if (text.length > 0) {
                    const textNode = document.createElement('div');
                    textNode.className = 'ai-explanation-example-text';
                    textNode.textContent = text;
                    item.appendChild(textNode);
                }

                if (explain.length > 0) {
                    const explainNode = document.createElement('div');
                    explainNode.className = 'ai-explanation-example-explain';
                    explainNode.textContent = explain;
                    item.appendChild(explainNode);
                }

                list.appendChild(item);
            }
            section.appendChild(list);
            this._content.appendChild(section);
        }
    }
}
