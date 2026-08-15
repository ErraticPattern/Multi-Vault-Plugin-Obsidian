type ChangeHandler<T> = (value: T) => unknown;

type ClickHandler = () => unknown;

export class FakeElement {
  tag: string;
  text = '';
  cls = '';
  children: FakeElement[] = [];
  settings: Setting[] = [];

  constructor(tag = 'div', attrs?: { text?: string; cls?: string }) {
    this.tag = tag;
    if (attrs?.text) this.text = attrs.text;
    if (attrs?.cls) this.cls = attrs.cls;
  }

  createEl(tag: string, attrs?: { text?: string; cls?: string }): FakeElement {
    const child = new FakeElement(tag, attrs);
    this.children.push(child);
    return child;
  }

  createDiv(attrs?: { text?: string; cls?: string }): FakeElement {
    return this.createEl('div', attrs);
  }

  empty(): void {
    this.children = [];
    this.settings = [];
    this.text = '';
  }

  setText(text: string): void {
    this.text = text;
  }
}

export class App {
  workspace: unknown;
  metadataCache: unknown;
  vault: unknown;
}

export class FileSystemAdapter {
  constructor(private readonly basePath = '') {}

  getBasePath(): string {
    return this.basePath;
  }
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat?: { mtime: number };

  constructor(path = '') {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
    const dot = this.name.lastIndexOf('.');
    this.extension = dot === -1 ? '' : this.name.slice(dot + 1);
    this.basename = dot === -1 ? this.name : this.name.slice(0, dot);
  }
}

const notices: string[] = [];
const openedModals: Modal[] = [];

export class Notice {
  constructor(public readonly message: string) {
    notices.push(message);
  }
}

export class Modal {
  contentEl = new FakeElement('div');
  isOpen = false;

  constructor(public readonly app: App) {}

  onOpen(): void {}

  onClose(): void {}

  open(): void {
    this.isOpen = true;
    openedModals.push(this);
    this.onOpen();
  }

  close(): void {
    this.isOpen = false;
    this.onClose();
  }
}

/** Only the surface an EditorSuggest subclass needs to exist and be constructed. */
export class EditorSuggest<T> {
  context: unknown = null;
  protected suggestions: T[] = [];

  constructor(public readonly app: App) {}

  close(): void {}
}

export class PluginSettingTab {
  containerEl = new FakeElement('div');

  constructor(public readonly app: App, public readonly plugin: unknown) {}

  display(): void {}

  update(): void {}
}

let requireApiVersionResult = false;

export function requireApiVersion(_version: string): boolean {
  return requireApiVersionResult;
}

export function __setRequireApiVersionResult(value: boolean): void {
  requireApiVersionResult = value;
}

export class ButtonComponent {
  buttonText = '';
  disabled = false;
  cta = false;
  warning = false;
  destructive = false;
  private onClickHandler: ClickHandler = () => undefined;

  setButtonText(text: string): this {
    this.buttonText = text;
    return this;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  setWarning(): this {
    this.warning = true;
    return this;
  }

  setDestructive(): this {
    this.destructive = true;
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onClick(handler: ClickHandler): this {
    this.onClickHandler = handler;
    return this;
  }

  async triggerClick(): Promise<unknown> {
    if (this.disabled) return undefined;
    return await this.onClickHandler();
  }
}

export class ToggleComponent {
  value = false;
  private onChangeHandler: ChangeHandler<boolean> = () => undefined;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  onChange(handler: ChangeHandler<boolean>): this {
    this.onChangeHandler = handler;
    return this;
  }

  async triggerChange(value: boolean): Promise<unknown> {
    this.value = value;
    return await this.onChangeHandler(value);
  }
}

export class DropdownComponent {
  value = '';
  options = new Map<string, string>();
  private onChangeHandler: ChangeHandler<string> = () => undefined;

  addOption(value: string, label: string): this {
    this.options.set(value, label);
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(handler: ChangeHandler<string>): this {
    this.onChangeHandler = handler;
    return this;
  }

  async triggerChange(value: string): Promise<unknown> {
    this.value = value;
    return await this.onChangeHandler(value);
  }
}

export class SliderComponent {
  value = 0;
  minimum = 0;
  maximum = 100;
  step = 1;
  dynamicTooltip = false;
  private onChangeHandler: ChangeHandler<number> = () => undefined;

  setLimits(minimum: number, maximum: number, step: number): this {
    this.minimum = minimum;
    this.maximum = maximum;
    this.step = step;
    return this;
  }

  setValue(value: number): this {
    this.value = value;
    return this;
  }

  setDynamicTooltip(): this {
    this.dynamicTooltip = true;
    return this;
  }

  onChange(handler: ChangeHandler<number>): this {
    this.onChangeHandler = handler;
    return this;
  }

  async triggerChange(value: number): Promise<unknown> {
    this.value = value;
    return await this.onChangeHandler(value);
  }
}

export class TextComponent {
  value = '';
  placeholder = '';
  private onChangeHandler: ChangeHandler<string> = () => undefined;

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(handler: ChangeHandler<string>): this {
    this.onChangeHandler = handler;
    return this;
  }

  async triggerChange(value: string): Promise<unknown> {
    this.value = value;
    return await this.onChangeHandler(value);
  }
}

export class TextAreaComponent extends TextComponent {}

export class ColorComponent extends TextComponent {}

export class Setting {
  name = '';
  desc = '';
  heading = false;
  descEl = new FakeElement('div');
  buttons: ButtonComponent[] = [];
  toggles: ToggleComponent[] = [];
  dropdowns: DropdownComponent[] = [];
  texts: TextComponent[] = [];
  textAreas: TextAreaComponent[] = [];
  colorPickers: ColorComponent[] = [];
  sliders: SliderComponent[] = [];

  constructor(containerEl: FakeElement) {
    containerEl.settings.push(this);
  }

  setName(name: string | DocumentFragment): this {
    this.name = typeof name === 'string' ? name : '';
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    this.desc = typeof desc === 'string' ? desc : '';
    this.descEl.setText(this.desc);
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  addButton(callback: (button: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    this.buttons.push(button);
    callback(button);
    return this;
  }

  addToggle(callback: (toggle: ToggleComponent) => unknown): this {
    const toggle = new ToggleComponent();
    this.toggles.push(toggle);
    callback(toggle);
    return this;
  }

  addDropdown(callback: (dropdown: DropdownComponent) => unknown): this {
    const dropdown = new DropdownComponent();
    this.dropdowns.push(dropdown);
    callback(dropdown);
    return this;
  }

  addText(callback: (text: TextComponent) => unknown): this {
    const text = new TextComponent();
    this.texts.push(text);
    callback(text);
    return this;
  }

  addTextArea(callback: (text: TextAreaComponent) => unknown): this {
    const text = new TextAreaComponent();
    this.textAreas.push(text);
    callback(text);
    return this;
  }

  addColorPicker(callback: (color: ColorComponent) => unknown): this {
    const color = new ColorComponent();
    this.colorPickers.push(color);
    callback(color);
    return this;
  }

  addSlider(callback: (slider: SliderComponent) => unknown): this {
    const slider = new SliderComponent();
    this.sliders.push(slider);
    callback(slider);
    return this;
  }
}

export type FuzzyMatch<T> = { item: T };

export class FuzzySuggestModal<T> extends Modal {
  placeholder = '';

  setPlaceholder(value: string): void {
    this.placeholder = value;
  }

  getItems(): T[] {
    return [];
  }

  getItemText(_item: T): string {
    return '';
  }

  onChooseItem(_item: T): void {}
}

export class SuggestModal<T> extends FuzzySuggestModal<T> {}

export function __resetObsidianMock(): void {
  notices.length = 0;
  openedModals.length = 0;
  requireApiVersionResult = false;
}

export function __getNotices(): string[] {
  return [...notices];
}

export function __getOpenedModals(): Modal[] {
  return [...openedModals];
}
