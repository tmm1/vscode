/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./nativeEditContext';
import * as browser from 'vs/base/browser/browser';
import { FastDomNode } from 'vs/base/browser/fastDomNode';
import { MOUSE_CURSOR_TEXT_CSS_CLASS_NAME } from 'vs/base/browser/ui/mouseCursor/mouseCursor';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import * as platform from 'vs/base/common/platform';
import { AbstractEditContext, ariaLabelForScreenReaderContent, CompositionContext, deduceInput, getAccessibilityOptions, ISimpleModel, ITypeData, PagedScreenReaderStrategy } from 'vs/editor/browser/controller/editContext/editContext';
import { HorizontalPosition, RenderingContext, RestrictedRenderingContext } from 'vs/editor/browser/view/renderingContext';
import { ViewController } from 'vs/editor/browser/view/viewController';
import { EditorOption, IComputedEditorOptions } from 'vs/editor/common/config/editorOptions';
import { OffsetRange } from 'vs/editor/common/core/offsetRange';
import { PositionOffsetTransformer } from 'vs/editor/common/core/positionToOffset';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import * as dom from 'vs/base/browser/dom';
import { ViewContext } from 'vs/editor/common/viewModel/viewContext';
import * as viewEvents from 'vs/editor/common/viewEvents';
import { IKeyboardEvent, StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { ScrollType } from 'vs/editor/common/editorCommon';
import { AccessibilitySupport, IAccessibilityService } from 'vs/platform/accessibility/common/accessibility';
import { IEditorAriaOptions } from 'vs/editor/browser/editorBrowser';
import { Position } from 'vs/editor/common/core/position';
import { applyFontInfo } from 'vs/editor/browser/config/domFontInfo';
import { Color } from 'vs/base/common/color';
import { EndOfLinePreference, IModelDeltaDecoration } from 'vs/editor/common/model';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { FontInfo } from 'vs/editor/common/config/fontInfo';
import { KeyCode } from 'vs/base/common/keyCodes';

/**
 * Correctly place the bounding boxes so that they are exactly aligned
 */

const canUseZeroSizeTextarea = (browser.isFirefox);

export class NativeEditContext extends AbstractEditContext {

	private readonly _domElement = new FastDomNode(document.createElement('div'));
	private readonly _editContext: EditContext = this._domElement.domNode.editContext = new EditContext();

	private _parent!: HTMLElement;
	private _accessibilitySupport!: AccessibilitySupport;
	private _accessibilityPageSize!: number;
	private _textAreaWrapping!: boolean;
	private _textAreaWidth!: number;
	private _contentLeft: number;
	private _contentWidth: number;
	private _contentHeight: number;
	private _fontInfo: FontInfo;
	private _lineHeight: number;
	private _selection: Selection;
	private _compositionStartPosition: Position | undefined;
	private _compositionEndPosition: Position | undefined;
	private _currentComposition: CompositionContext | undefined;
	private _selectionOfContent: Range | undefined;
	private _renderingContext: RenderingContext | undefined;

	private _scrollLeft: number = 0;
	private _scrollTop: number = 0;
	private _rangeStart: number = 0;
	private _hasFocus: boolean = false;
	private _selectionStartWithinScreenReaderContent: number = 0;
	private _selectionEndWithinScreenReaderContent: number = 0;

	private _selectionBounds: IDisposable = Disposable.None;
	private _controlBounds: IDisposable = Disposable.None;
	private _characterBounds: IDisposable = Disposable.None;

	constructor(
		context: ViewContext,
		private readonly _viewController: ViewController,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
	) {
		super(context);

		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);

		this._setAccessibilityOptions(options);
		this._contentLeft = layoutInfo.contentLeft;
		this._contentWidth = layoutInfo.contentWidth;
		this._contentHeight = layoutInfo.height;
		this._fontInfo = options.get(EditorOption.fontInfo);
		this._lineHeight = options.get(EditorOption.lineHeight);

		this._selection = new Selection(1, 1, 1, 1);
		this._domElement.setClassName(`native-edit-context ${MOUSE_CURSOR_TEXT_CSS_CLASS_NAME}`);
		const { tabSize } = this._context.viewModel.model.getOptions();
		this._domElement.domNode.style.tabSize = `${tabSize * this._fontInfo.spaceWidth}px`;
		this._domElement.setAttribute('aria-label', ariaLabelForScreenReaderContent(options, this._keybindingService));
		this._domElement.setAttribute('tabindex', String(options.get(EditorOption.tabIndex)));
		this._domElement.setAttribute('role', 'textbox');

		let lastKeyDown: IKeyboardEvent | null = null;
		this._register(dom.addDisposableListener(this._domElement.domNode, 'keydown', (e) => {
			console.log('keydown : ', e);
			console.log('this._currentComposition : ', this._currentComposition);
			const standardKeyboardEvent = new StandardKeyboardEvent(e);
			if (standardKeyboardEvent.keyCode === KeyCode.KEY_IN_COMPOSITION
				|| (this._currentComposition && standardKeyboardEvent.keyCode === KeyCode.Backspace)) {
				console.log('stopping the propagation');
				// Stop propagation for keyDown events if the IME is processing key input
				standardKeyboardEvent.stopPropagation();
			}
			lastKeyDown = standardKeyboardEvent;
			this._domElement.domNode.focus();
			this._viewController.emitKeyDown(standardKeyboardEvent);
		}));

		this._register(dom.addDisposableListener(this._domElement.domNode, 'keyup', (e) => {
			this._viewController.emitKeyUp(new StandardKeyboardEvent(e));
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'textupdate', e => {

			console.log('textupdate : ', e);
			console.log('e.text : ', e.text);
			console.log('e.updateRangeStart : ', e.updateRangeStart);
			console.log('e.updateRangeEnd : ', e.updateRangeEnd);
			console.log('this._editContext.text : ', this._editContext.text);

			const data = e.text.replaceAll(/[^\S\r\n]/gmu, ' ');
			if (this._currentComposition) {
				this.onInputWithComposition(this._currentComposition, data);
			} else {
				this.onInputWithoutComposition(data);
			}
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'compositionstart', e => {

			this._updateCompositionStartPosition();

			const currentComposition = new CompositionContext();
			if (this._currentComposition) {
				// simply reset the composition context
				this._currentComposition = currentComposition;
				return;
			}
			this._currentComposition = currentComposition;

			console.log('oncompositionstart : ', e);
			console.log('platform.OS === platform.OperatingSystem.Macintosh : ', platform.OS === platform.OperatingSystem.Macintosh);
			console.log('lastKeyDown : ', lastKeyDown);
			console.log('lastKeyDown.equals(KeyCode.KEY_IN_COMPOSITION) : ', lastKeyDown?.equals(KeyCode.KEY_IN_COMPOSITION));
			console.log('this._editContext.selectionStart : ', this._editContext.selectionStart);
			console.log('this._editContext.selectionEnd : ', this._editContext.selectionEnd);
			console.log('this._editContext.text.substring(this._editContext.selectionStart - 1, this._editContext.selectionEnd) : ', this._editContext.text.substring(this._editContext.selectionStart - 1, this._editContext.selectionEnd));
			console.log('(e.currentTarget as EditContext).text.substring(this._editContext.selectionStart - 1, this._editContext.selectionEnd) : ', (e.currentTarget as EditContext).text.substring(this._editContext.selectionStart - 1, this._editContext.selectionEnd));
			console.log('(lastKeyDown.code === ArrowRight || lastKeyDown.code === ArrowLeft) : ', (lastKeyDown?.code === 'ArrowRight' || lastKeyDown?.code === 'ArrowLeft'));

			const isMacintosh = platform.OS === platform.OperatingSystem.Macintosh;
			const isLastKeyDownInComposition = lastKeyDown && lastKeyDown.equals(KeyCode.KEY_IN_COMPOSITION);
			const isSelectionStartEqualToSelectionEnd = this._editContext.selectionStart === this._editContext.selectionEnd;
			const areSubstringsEqual = this._editContext.text.substring(this._editContext.selectionStart - 1, this._editContext.selectionEnd) === (e.currentTarget as EditContext).text.substring(this._editContext.selectionStart - 1, this._editContext.selectionEnd);
			const isLastKeydownArrowKey = lastKeyDown && (lastKeyDown.code === 'ArrowRight' || lastKeyDown.code === 'ArrowLeft');
			if (
				isMacintosh
				&& isLastKeyDownInComposition
				&& isSelectionStartEqualToSelectionEnd
				&& this._editContext.selectionStart > 0
				&& areSubstringsEqual
				&& isLastKeydownArrowKey
			) {
				console.log('before handle composition update');
				// Handling long press case on Chromium/Safari macOS + arrow key => pretend the character was selected
				// Pretend the previous character was composed (in order to get it removed by subsequent compositionupdate events)
				currentComposition.handleCompositionUpdate('x');
			}
			this._context.viewModel.revealRange(
				'keyboard',
				true,
				Range.fromPositions(this._selection.getStartPosition()),
				viewEvents.VerticalRevealType.Simple,
				ScrollType.Immediate
			);
			this._render();
			this._domElement.setClassName(`native-edit-context ${MOUSE_CURSOR_TEXT_CSS_CLASS_NAME} ime-input`);
			this._viewController.compositionStart();
			this._context.viewModel.onCompositionStart();
		}));

		this._register(editContextAddDisposableListener(this._editContext, 'compositionend', e => {

			console.log('oncompositionend : ', e);

			this._updateCompositionEndPosition();

			const currentComposition = this._currentComposition;
			if (!currentComposition) {
				return;
			}
			this._currentComposition = undefined;

			if ('data' in e && typeof e.data === 'string') {
				const typeInput = currentComposition.handleCompositionUpdate(e.data);
				this._onType(typeInput);
				this._render();
				this._domElement.setClassName(`native-edit-context ${MOUSE_CURSOR_TEXT_CSS_CLASS_NAME}`);
				this._viewController.compositionEnd();
				this._context.viewModel.onCompositionEnd();
			}
		}));
		this._register(dom.addDisposableListener(this._domElement.domNode, 'beforeinput', (e) => {

			console.log('beforeinput : ', e);

			if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {

				console.log('this._editContext.text : ', this._editContext.text);

				const textAfterAddingNewLine = this._editContext.text.substring(0, this._editContext.selectionStart) + '\n' + this._editContext.text.substring(this._editContext.selectionEnd);
				this._editContext.updateText(0, Number.MAX_SAFE_INTEGER, textAfterAddingNewLine);
				this.onInputWithoutComposition('\n');
			}
		}));
		this._register(dom.addDisposableListener(this._domElement.domNode, 'paste', (e) => {
			console.log('paste : ', e);
			// TODO does not work
		}));
		this._register(dom.addDisposableListener(this._domElement.domNode, 'cut', (e) => {
			console.log('cut : ', e);
			// TODO does not work
		}));
		this._register(dom.addDisposableListener(this._domElement.domNode, 'copy', (e) => {
			console.log('copy : ', e);
			// TODO: this does work but corresponding paste and cut do not work
		}));

		this._register(editContextAddDisposableListener(this._editContext, 'textformatupdate', e => {
			this._handleTextFormatUpdate(e);
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'characterboundsupdate', e => {
			console.log('characterboundsupdate : ', e);

			this._rangeStart = e.rangeStart;
			this._updateCharacterBounds(e.rangeStart);
		}));
		this._register(dom.addDisposableListener(this._domElement.domNode, 'focus', (e) => {
			this._setHasFocus(true);
		}));

		this._register(dom.addDisposableListener(this._domElement.domNode, 'blur', (e) => {
			this._setHasFocus(false);
		}));
	}

	appendTo(overflowGuardContainer: FastDomNode<HTMLElement>): void {
		overflowGuardContainer.appendChild(this._domElement);
		this._parent = overflowGuardContainer.domNode;
	}

	public writeScreenReaderContent(reason: string): void {
		if ((!this._accessibilityService.isScreenReaderOptimized() && reason === 'render') || this._currentComposition) {
			// Do not write to the text on render unless a screen reader is being used #192278
			// Do not write to the text area when doing composition
			return;
		}
		const screenReaderContentState = this._getScreenReaderContentState();
		this._setScreenReaderContent(reason, screenReaderContentState.value);
		this._setSelectionOfScreenReaderContent(reason, screenReaderContentState.selectionStart, screenReaderContentState.selectionEnd);
	}

	public writeEditContextContent(): void {

		const editContextState = this._getEditContextState();
		this._selectionOfContent = editContextState.selectionOfContent;
		this._editContext.updateText(0, Number.MAX_SAFE_INTEGER, editContextState.value);
		this._editContext.updateSelection(editContextState.selectionStart, editContextState.selectionEnd);

		console.log('updateText');
		console.log('IMEContentData : ', editContextState);
		console.log('this._editContext.text : ', this._editContext.text);
		console.log('editContextContentState.selectionStart : ', editContextState.selectionStart);
		console.log('editContextContentState.selectionEnd : ', editContextState.selectionEnd);
		console.log('this._selectionOfContent : ', this._selectionOfContent);
	}

	public override dispose(): void {
		super.dispose();
	}

	private _setAccessibilityOptions(options: IComputedEditorOptions): void {
		const { accessibilitySupport, accessibilityPageSize, textAreaWrapping, textAreaWidth } = getAccessibilityOptions(options, canUseZeroSizeTextarea);
		this._accessibilitySupport = accessibilitySupport;
		this._accessibilityPageSize = accessibilityPageSize;
		this._textAreaWrapping = textAreaWrapping;
		this._textAreaWidth = textAreaWidth;
	}

	// --- begin event handlers

	public override onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this._setAccessibilityOptions(options);
		this._contentLeft = layoutInfo.contentLeft;
		this._contentWidth = layoutInfo.contentWidth;
		this._contentHeight = layoutInfo.height;
		this._fontInfo = options.get(EditorOption.fontInfo);
		this._lineHeight = options.get(EditorOption.lineHeight);
		this._domElement.setAttribute('wrap', this._textAreaWrapping ? 'on' : 'off');
		const { tabSize } = this._context.viewModel.model.getOptions();
		this._domElement.domNode.style.tabSize = `${tabSize * this._fontInfo.spaceWidth}px`;
		this._domElement.setAttribute('aria-label', ariaLabelForScreenReaderContent(options, this._keybindingService));
		this._domElement.setAttribute('tabindex', String(options.get(EditorOption.tabIndex)));
		if (e.hasChanged(EditorOption.accessibilitySupport)) {
			this.writeScreenReaderContent('strategy changed');
		}
		return true;
	}

	public override onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		this._selection = e.selections.slice(0)[0] ?? new Selection(1, 1, 1, 1);
		// We must update the <textarea> synchronously, otherwise long press IME on macos breaks.
		// See https://github.com/microsoft/vscode/issues/165821
		this.writeScreenReaderContent('selection changed');
		this.writeEditContextContent();
		this._updateBounds();
		return true;
	}

	public override onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		this._scrollLeft = e.scrollLeft;
		this._scrollTop = e.scrollTop;
		this._updateBounds();
		return true;
	}

	// --- end event handlers

	// --- begin view API

	public isFocused(): boolean {
		return this._hasFocus;
	}

	public focusTextArea(): void {
		// Setting this._hasFocus and writing the screen reader content
		// will result in a focus() and setSelectionRange() in the textarea
		this._setHasFocus(true);

		// If the editor is off DOM, focus cannot be really set, so let's double check that we have managed to set the focus
		this.refreshFocusState();
	}

	public refreshFocusState(): void {
		console.log('refreshFocusState');

		// TODO: not sure why this does not work
		// let hasFocus: boolean = true;
		// const shadowRoot = dom.getShadowRoot(this._domElement.domNode);
		// if (shadowRoot) {
		// 	console.log('1');
		// 	hasFocus = shadowRoot.activeElement === this._domElement.domNode;
		// } else if (this._domElement.domNode.isConnected) {
		// 	console.log('2');
		// 	hasFocus = dom.getActiveElement() === this._domElement.domNode;
		// } else {
		// 	console.log('3');
		// 	hasFocus = false;
		// }
		// console.log('hasFocus : ', hasFocus);
		const hasFocus = true;
		this._setHasFocus(hasFocus);
	}

	private _setHasFocus(newHasFocus: boolean): void {
		if (this._hasFocus === newHasFocus) {
			// no change
			return;
		}
		this._hasFocus = newHasFocus;

		if (this._hasFocus) {
			// write to the screen reader content
		}

		if (this._hasFocus) {
			this._context.viewModel.setHasFocus(true);
		} else {
			this._context.viewModel.setHasFocus(false);
		}
	}

	public setAriaOptions(options: IEditorAriaOptions): void { }

	// --- end view API

	private _primaryCursorPosition: Position = new Position(1, 1);
	private _primaryCursorVisibleRange: HorizontalPosition | null = null;

	public prepareRender(ctx: RenderingContext): void {
		this._renderingContext = ctx;
		this._primaryCursorPosition = new Position(this._selection.positionLineNumber, this._selection.positionColumn);
		this._primaryCursorVisibleRange = ctx.visibleRangeForPosition(this._primaryCursorPosition);
	}

	public render(ctx: RestrictedRenderingContext): void {
		this.writeScreenReaderContent('render');
		this.writeEditContextContent();
		this._render();
	}

	private _render(): void {
		if (!this._primaryCursorVisibleRange) {
			// The primary cursor is outside the viewport => place textarea to the top left
			this._renderAtTopLeft();
			return;
		}

		const left = this._contentLeft + this._primaryCursorVisibleRange.left - this._scrollLeft;
		if (left < this._contentLeft || left > this._contentLeft + this._contentWidth) {
			// cursor is outside the viewport
			this._renderAtTopLeft();
			return;
		}

		const top = this._context.viewLayout.getVerticalOffsetForLineNumber(this._selection.positionLineNumber) - this._scrollTop;
		if (top < 0 || top > this._contentHeight) {
			// cursor is outside the viewport
			this._renderAtTopLeft();
			return;
		}

		// The primary cursor is in the viewport (at least vertically) => place textarea on the cursor

		if (platform.isMacintosh || this._accessibilitySupport === AccessibilitySupport.Enabled) {
			// For the popup emoji input, we will make the text area as high as the line height
			// We will also make the fontSize and lineHeight the correct dimensions to help with the placement of these pickers
			this._doRender({
				lastRenderPosition: this._primaryCursorPosition,
				top,
				left: this._textAreaWrapping ? this._contentLeft : left,
				width: this._textAreaWidth,
				height: this._lineHeight,
				useCover: false
			});
			// In case the textarea contains a word, we're going to try to align the textarea's cursor
			// with our cursor by scrolling the textarea as much as possible
			this._domElement.domNode.scrollLeft = this._primaryCursorVisibleRange.left;
			const divValue = this._domElement.domNode.textContent ?? '';
			console.log('_render');
			const lineCount = this._newlinecount(divValue.substring(0, this._selectionStartWithinScreenReaderContent));
			this._domElement.domNode.scrollTop = lineCount * this._lineHeight;
			return;
		}

		this._doRender({
			lastRenderPosition: this._primaryCursorPosition,
			top: top,
			left: this._textAreaWrapping ? this._contentLeft : left,
			width: this._textAreaWidth,
			height: (canUseZeroSizeTextarea ? 0 : 1),
			useCover: false
		});
	}

	private _newlinecount(text: string): number {
		let result = 0;
		let startIndex = -1;
		do {
			startIndex = text.indexOf('\n', startIndex + 1);
			if (startIndex === -1) {
				break;
			}
			result++;
		} while (true);
		return result;
	}

	private _renderAtTopLeft(): void {
		// (in WebKit the textarea is 1px by 1px because it cannot handle input to a 0x0 textarea)
		// specifically, when doing Korean IME, setting the textarea to 0x0 breaks IME badly.
		this._doRender({
			lastRenderPosition: null,
			top: 0,
			left: 0,
			width: this._textAreaWidth,
			height: (canUseZeroSizeTextarea ? 0 : 1),
			useCover: true
		});
	}

	private _doRender(renderData: IRenderData): void {

		applyFontInfo(this._domElement, this._fontInfo);
		this._domElement.setTop(renderData.top);
		this._domElement.setLeft(renderData.left);
		this._domElement.setWidth(renderData.width);
		this._domElement.setHeight(renderData.height);

		this._domElement.setColor(renderData.color ? Color.Format.CSS.formatHex(renderData.color) : '');
		this._domElement.setFontStyle(renderData.italic ? 'italic' : '');
		if (renderData.bold) {
			// fontWeight is also set by `applyFontInfo`, so only overwrite it if necessary
			this._domElement.setFontWeight('bold');
		}
		this._domElement.setTextDecoration(`${renderData.underline ? ' underline' : ''}${renderData.strikethrough ? ' line-through' : ''}`);
	}

	// -- additional code

	private _onType(typeInput: ITypeData): void {
		console.log('_onType');
		if (typeInput.replacePrevCharCnt || typeInput.replaceNextCharCnt || typeInput.positionDelta) {
			console.log('before composition type');
			this._viewController.compositionType(typeInput.text, typeInput.replacePrevCharCnt, typeInput.replaceNextCharCnt, typeInput.positionDelta);
		} else {
			this._viewController.type(typeInput.text);
		}
	}

	private _getScreenReaderContentState(): {
		value: string;
		selectionStart: number;
		selectionEnd: number;
	} {
		const simpleModel: ISimpleModel = {
			getLineCount: (): number => {
				return this._context.viewModel.getLineCount();
			},
			getLineMaxColumn: (lineNumber: number): number => {
				return this._context.viewModel.getLineMaxColumn(lineNumber);
			},
			getValueInRange: (range: Range, eol: EndOfLinePreference): string => {
				return this._context.viewModel.getValueInRange(range, eol);
			},
			getValueLengthInRange: (range: Range, eol: EndOfLinePreference): number => {
				return this._context.viewModel.getValueLengthInRange(range, eol);
			},
			modifyPosition: (position: Position, offset: number): Position => {
				return this._context.viewModel.modifyPosition(position, offset);
			}
		};

		if (this._accessibilitySupport === AccessibilitySupport.Disabled) {
			// When accessibility is turned off we not need the screen reader content
			return {
				value: '',
				selectionStart: 0,
				selectionEnd: 0
			};
		}
		return PagedScreenReaderStrategy.fromEditorSelection(simpleModel, this._selection, this._accessibilityPageSize, this._accessibilitySupport === AccessibilitySupport.Unknown);
	}

	public _getEditContextState(): {
		value: string;
		selectionStart: number;
		selectionEnd: number;
		selectionOfContent: Selection;
	} {
		const cursorState = this._context.viewModel.getPrimaryCursorState().modelState;
		const selectionOfContent = cursorState.selection;
		// Need to do multiline also
		let value = '';
		let selectionStart: number = 0;
		let selectionEnd: number = 0;
		for (let i = selectionOfContent.startLineNumber; i <= selectionOfContent.endLineNumber; i++) {
			value += this._context.viewModel.getLineContent(i);
			if (i === selectionOfContent.startLineNumber) {
				selectionStart = selectionOfContent.startColumn - 1;
			}
			if (i === selectionOfContent.endLineNumber) {
				selectionEnd += selectionOfContent.endColumn - 1;
			} else {
				selectionEnd += this._context.viewModel.getLineMaxColumn(i) - 1;
			}
		}
		return {
			value,
			selectionStart,
			selectionEnd,
			selectionOfContent,
		};
	}

	private _setScreenReaderContent(reason: string, value: string): void {

		console.log('setValue : ', value);
		console.log('value : ', value);

		if (this._domElement.domNode.textContent === value) {
			// No change
			return;
		}
		this._domElement.domNode.textContent = value;
	}

	private _setSelectionOfScreenReaderContent(reason: string, selectionStart: number, selectionEnd: number): void {

		console.log('setSelectionRange');
		console.log('selectionStart : ', selectionStart);
		console.log('selectionEnd : ', selectionEnd);

		const domNode = this._domElement.domNode;

		let activeElement: Element | null = null;
		const shadowRoot = dom.getShadowRoot(domNode);
		if (shadowRoot) {
			activeElement = shadowRoot.activeElement;
		} else {
			activeElement = dom.getActiveElement();
		}
		const activeWindow = dom.getWindow(activeElement);

		const currentIsFocused = (activeElement === domNode);

		if (currentIsFocused && this._selectionStartWithinScreenReaderContent === selectionStart && this._selectionEndWithinScreenReaderContent === selectionEnd) {
			// No change
			// Firefox iframe bug https://github.com/microsoft/monaco-editor/issues/643#issuecomment-367871377
			if (browser.isFirefox && activeWindow.parent !== activeWindow) {
				domNode.focus();
			}
			return;
		}

		// console.log('reason: ' + reason + ', setSelectionRange: ' + selectionStart + ' -> ' + selectionEnd);

		if (currentIsFocused) {
			// No need to focus, only need to change the selection range
			this._updateDocumentSelection(selectionStart, selectionEnd);
			if (browser.isFirefox && activeWindow.parent !== activeWindow) {
				domNode.focus();
			}
			return;
		}

		// If the focus is outside the textarea, browsers will try really hard to reveal the textarea.
		// Here, we try to undo the browser's desperate reveal.
		try {
			const scrollState = dom.saveParentsScrollTop(domNode);
			domNode.focus();
			this._updateDocumentSelection(selectionStart, selectionEnd);
			dom.restoreParentsScrollTop(domNode, scrollState);
		} catch (e) {
			// Sometimes IE throws when setting selection (e.g. textarea is off-DOM)
		}
	}

	private _updateDocumentSelection(selectionStart: number, selectionEnd: number) {

		console.log('_updateDocumentSelection');
		console.log('selectionStart : ', selectionStart);
		console.log('selectionEnd : ', selectionEnd);

		this._selectionStartWithinScreenReaderContent = selectionStart;
		this._selectionEndWithinScreenReaderContent = selectionEnd;

		const activeDocument = dom.getActiveWindow().document;
		const activeDocumentSelection = activeDocument.getSelection();
		if (activeDocumentSelection) {
			const range = new globalThis.Range();
			const firstChild = this._domElement.domNode.firstChild;
			if (firstChild) {
				range.setStart(firstChild, selectionStart);
				range.setEnd(firstChild, selectionEnd);
				activeDocumentSelection.removeAllRanges();
				activeDocumentSelection.addRange(range);
			}
		}
	}

	public onInputWithoutComposition(text: string) {
		if (this._currentComposition) {
			return;
		}
		const newOffset = this._editContext.selectionStart + text.length;
		const newValue = this._editContext.text.substring(0, this._editContext.selectionStart) + text + this._editContext.text.substring(this._editContext.selectionEnd);
		const previousState = { value: this._editContext.text, selectionStart: this._editContext.selectionStart, selectionEnd: this._editContext.selectionEnd };
		const currentState = { value: newValue, selectionStart: newOffset, selectionEnd: newOffset };
		const typeInput = deduceInput(previousState, currentState);

		console.log('onInput');
		console.log('typeInput : ', typeInput);

		if (
			typeInput.text !== ''
			|| typeInput.replacePrevCharCnt !== 0
			|| typeInput.replaceNextCharCnt !== 0
			|| typeInput.positionDelta !== 0
		) {
			this._onType(typeInput);
		}
	}

	public onInputWithComposition(composition: CompositionContext, data: string): void {

		this._updateCompositionEndPosition();

		const compositionInput = composition.handleCompositionUpdate(data);

		console.log('compositionInput : ', compositionInput);

		this._onType(compositionInput);
		this._render();
	}

	private _updateCharacterBounds(rangeStart: number) {

		console.log('_updateCharacterBounds');
		console.log('this._parent : ', this._parent);
		console.log('this._compositionStartPosition : ', this._compositionStartPosition);
		console.log('this._compositionEndPosition : ', this._compositionEndPosition);

		if (!this._parent || !this._compositionStartPosition || !this._compositionEndPosition) {
			console.log('early return of _updateCharacterBounds');
			return;
		}

		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);
		const typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		const parentBounds = this._parent.getBoundingClientRect();
		const verticalOffsetStart = this._context.viewLayout.getVerticalOffsetForLineNumber(this._compositionStartPosition.lineNumber);
		let left: number = parentBounds.left + this._contentLeft;
		let width: number = typicalHalfwidthCharacterWidth / 2;

		console.log('before using this rendering context');
		console.log('this._renderingContext : ', this._renderingContext);

		if (this._renderingContext) {
			const range = Range.fromPositions(this._compositionStartPosition, this._compositionEndPosition);
			const linesVisibleRanges = this._renderingContext.linesVisibleRangesForRange(range, true) ?? [];

			console.log('range : ', range);
			console.log('linesVisibleRanges : ', linesVisibleRanges);

			if (linesVisibleRanges.length === 0) { return; }
			const minLeft = Math.min(...linesVisibleRanges.map(r => Math.min(...r.ranges.map(r => r.left))));
			const maxLeft = Math.max(...linesVisibleRanges.map(r => Math.max(...r.ranges.map(r => r.left + r.width))));
			left += minLeft;
			width = maxLeft - minLeft;
		}

		console.log('before setting characterBounds');

		const characterBounds = [new DOMRect(
			left,
			parentBounds.top + verticalOffsetStart - this._scrollTop,
			width,
			lineHeight,
		)];

		console.log('characterBounds : ', characterBounds);
		this._editContext.updateCharacterBounds(rangeStart, characterBounds);

		// -- dev
		this._characterBounds.dispose();
		this._characterBounds = createRect(characterBounds[0], 'green');
	}

	private _decorations: string[] = [];

	// do we need this? looks like in the current implementation we wouldnt use these format
	private _handleTextFormatUpdate(e: TextFormatUpdateEvent): void {

		const formats = e.getTextFormats();

		console.log('_handleTextFormatUpdate');
		console.log('e : ', e);
		console.log('formats : ', formats);

		const decorations: IModelDeltaDecoration[] = [];
		formats.forEach(f => {
			const offsetRange = new OffsetRange(f.rangeStart, f.rangeEnd);
			const textPositionTransformer = new PositionOffsetTransformer(this._editContext.text);
			const range = textPositionTransformer.getRange(offsetRange);

			console.log('range : ', range);
			console.log('this._selectionOfValue : ', this._selectionOfContent);

			if (!this._selectionOfContent) {
				return;
			}
			const startLineNumber = this._selectionOfContent.startLineNumber + range.startLineNumber - 1;
			const endLineNumber = this._selectionOfContent.startLineNumber + range.endLineNumber - 1;
			let startColumn: number;
			if (startLineNumber === this._selectionOfContent.startLineNumber) {
				startColumn = this._selectionOfContent.startColumn + range.startColumn - 1;
			} else {
				startColumn = range.startColumn;
			}
			let endColumn: number;
			if (endLineNumber === this._selectionOfContent.startLineNumber) {
				endColumn = this._selectionOfContent.startColumn + range.endColumn - 1;
			} else {
				endColumn = range.endColumn;
			}
			const decorationRange = new Range(startLineNumber, startColumn, endLineNumber, endColumn);

			console.log('decorationRange : ', decorationRange);

			const classNames = [
				'underline',
				`style-${f.underlineStyle.toLowerCase()}`,
				`thickness-${f.underlineThickness.toLowerCase()}`,
			];
			decorations.push({
				range: decorationRange,
				options: {
					description: 'textFormatDecoration',
					inlineClassName: classNames.join(' '),
				}
			});
		});

		console.log('decorations : ', decorations);

		this._decorations = this._context.viewModel.model.deltaDecorations(this._decorations, decorations);
	}

	private _updateBounds() {
		this._updateSelectionAndControlBounds();
		// Need to update character bounds eagerly in order for the IME to be positioned correctly
		this._updateCharacterBounds(this._rangeStart);
	}

	private _updateSelectionAndControlBounds() {

		console.log('_updateBounds');

		if (!this._parent) {
			return;
		}
		const primaryViewState = this._context.viewModel.getCursorStates()[0].viewState;
		const primarySelection = primaryViewState.selection;
		const parentBounds = this._parent.getBoundingClientRect();
		const verticalOffsetStart = this._context.viewLayout.getVerticalOffsetForLineNumber(primarySelection.startLineNumber);
		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);

		let selectionBounds: DOMRect;
		let controlBounds: DOMRect;
		if (primarySelection.isEmpty()) {
			const typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
			let left: number = parentBounds.left + this._contentLeft;
			if (this._renderingContext) {
				const linesVisibleRanges = this._renderingContext.linesVisibleRangesForRange(primaryViewState.selection, true) ?? [];
				if (linesVisibleRanges.length === 0) { return; }
				const minLeft = Math.min(...linesVisibleRanges.map(r => Math.min(...r.ranges.map(r => r.left))));
				left += (minLeft + typicalHalfwidthCharacterWidth / 2);
			}
			selectionBounds = new DOMRect(
				left,
				parentBounds.top + verticalOffsetStart - this._scrollTop,
				typicalHalfwidthCharacterWidth / 2,
				lineHeight,
			);
			controlBounds = selectionBounds;
		} else {
			const numberOfLines = primarySelection.endLineNumber - primarySelection.startLineNumber;
			selectionBounds = new DOMRect(
				parentBounds.left + this._contentLeft,
				parentBounds.top + verticalOffsetStart - this._scrollTop,
				parentBounds.width - this._contentLeft,
				(numberOfLines + 1) * lineHeight,
			);
			controlBounds = selectionBounds;
		}

		console.log('selectionBounds : ', selectionBounds);
		console.log('controlBounds : ', controlBounds);

		this._editContext.updateControlBounds(controlBounds);
		this._editContext.updateSelectionBounds(selectionBounds);

		// visualizing the selection bounds
		this._selectionBounds.dispose();
		this._controlBounds.dispose();
		this._selectionBounds = createRect(selectionBounds, 'red');
		this._controlBounds = createRect(controlBounds, 'blue');
	}

	private _updateCompositionEndPosition(): void {
		this._compositionEndPosition = this._context.viewModel.getCursorStates()[0].viewState.position;
	}

	private _updateCompositionStartPosition(): void {
		this._compositionStartPosition = this._context.viewModel.getCursorStates()[0].viewState.position;
	}
}

function editContextAddDisposableListener<K extends keyof EditContextEventHandlersEventMap>(target: EventTarget, type: K, listener: (this: GlobalEventHandlers, ev: EditContextEventHandlersEventMap[K]) => any, options?: boolean | AddEventListenerOptions): IDisposable {
	target.addEventListener(type, listener as any, options);
	return {
		dispose() {
			target.removeEventListener(type, listener as any);
		}
	};
}

interface IRenderData {
	lastRenderPosition: Position | null;
	top: number;
	left: number;
	width: number;
	height: number;
	useCover: boolean;

	color?: Color | null;
	italic?: boolean;
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
}

function createRect(rect: DOMRect, color: 'red' | 'blue' | 'green'): IDisposable {
	const ret = document.createElement('div');
	ret.style.position = 'absolute';
	ret.style.zIndex = '999999999';
	ret.style.outline = `2px solid ${color}`;
	ret.className = 'debug-rect-marker';
	ret.style.pointerEvents = 'none';

	ret.style.top = rect.top + 'px';
	ret.style.left = rect.left + 'px';
	ret.style.width = rect.width + 'px';
	ret.style.height = rect.height + 'px';

	// eslint-disable-next-line no-restricted-syntax
	document.body.appendChild(ret);

	return {
		dispose: () => {
			ret.remove();
		}
	};
}