import { App, Modal, Setting, DropdownComponent, TextAreaComponent, FuzzySuggestModal, FuzzyMatch, Notice } from "obsidian";
import { Category } from "./interfaces";

const inboxCategory: Category = {
  _id: "__inbox-faux__", // Arbitrary unique ID for the Inbox faux category
  title: "Inbox",
  type: "faux",
  updatedAt: 0,
  parentId: "root",
  startDate: "",
  endDate: "",
  note: "",
  isRecurring: false,
  priority: "",
  deepLink: "",
  dueDate: "",
  done: false,
};

function getTitleWithParent(category: Category, categories: Category[]): string {
  let parent = category.parentId;

  let parentTitle = [];
  while (parent && parent !== "root") {
    const parentCategory = categories.find(category => category._id === parent);
    if (parentCategory) {
      parentTitle.push(parentCategory.title);
      parent = parentCategory.parentId;
    } else {
      break;
    }
  }
  if (parentTitle.length > 0) {
    return category.title + ` in ${parentTitle.reverse().join("/")}`;
  }
  return category.title;
}

// Suggester Modal Class for Category Selection
class CategorySuggesterModal extends FuzzySuggestModal<Category> {
  categories: Category[];

  onChooseItem: (item: Category, _evt: MouseEvent | KeyboardEvent) => void;
  getItems(): Category[] {

    // Include the Inbox at the beginning of the categories list
    return [inboxCategory, ...this.categories];
  }
  getItemText(category: Category): string {
    if (category.type === "faux") {
      return "Inbox";
    }
    return getTitleWithParent(category, this.categories);
  }

  constructor(app: App, categories: Category[], onChooseItem: (item: Category, _evt: MouseEvent | KeyboardEvent) => void) {
    super(app);
    this.categories = categories;
    this.onChooseItem = onChooseItem;
  }

  onChooseSuggestion(item: FuzzyMatch<Category>, _evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(item.item, _evt);
  }
}

export class AddTaskModal extends Modal {
  result: { catId: string, task: string };
  onSubmit: (result: { catId: string, task: string }) => void;
  categories: Category[];

  constructor(
    app: App,
    categories: Category[],
    onSubmit: (result: { catId: string; task: string; }) => void,
    defaultCategoryId = inboxCategory._id,
  ) {
    super(app);
    this.onSubmit = onSubmit;
    this.categories = categories.sort((a, b) => {
      return this.getFullPathToCategoryTitle(a, categories).localeCompare(this.getFullPathToCategoryTitle(b, categories));
    });
    this.result = { catId: defaultCategoryId, task: '' };
  }

  onOpen() {
    const { contentEl } = this;
    let categoryInput: HTMLInputElement;

    contentEl.createEl("h1", { text: "New Amazing Marvin Task" });

    new Setting(contentEl)
      .setName("Category")
      .addText(text => {
        categoryInput = text.inputEl;
        const selectedCategory = this.categories.find(
          category => category._id === this.result.catId,
        ) ?? inboxCategory;
        text.setValue(selectedCategory.title);
        this.result.catId = selectedCategory._id;
        text.onChange(value => {
          const suggester = new CategorySuggesterModal(this.app, this.categories, (item: Category) => {
            categoryInput.value = item.title;
            this.result.catId = item._id;
            suggester.close();
          });
          suggester.open();
        });
      });

    new Setting(contentEl)
      .setHeading().setName("Task");

    new Setting(contentEl)
      .addTextArea((textArea: TextAreaComponent) => {
        textArea.onChange((value: string) => {
          this.result.task = value;
        });
      }).settingEl.addClass("am-task-textarea-setting");

    const shortcutsDesc = document.createDocumentFragment();
    shortcutsDesc.appendText('The Task field accepts labels (@), time estimates (~), and scheduled dates (+). See ');
    shortcutsDesc.appendChild(this.getShortcutsLink());
    shortcutsDesc.appendText('.');

    new Setting(contentEl)
      .setDesc(shortcutsDesc);

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(() => {
            this.addTask();
          }));

    this.modalEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        this.addTask();
      }
    });

  }

  private addTask() {
    if (!this.result.task.trim()) {
      new Notice('Please enter a task description.', 4000);
      return;
    }
    this.close();
    if (this.onSubmit && this.result.task) {
      this.onSubmit(this.result);
    }
  }



  private getShortcutsLink(): HTMLAnchorElement {
    const a = document.createElement('a');
    a.href = 'https://help.amazingmarvin.com/en/articles/1949399-using-shortcuts-while-creating-a-task';
    a.text = 'Using shortcuts while creating a task';
    a.target = '_blank';
    return a;
  }

  private getFullPathToCategoryTitle(category: Category, categories: Category[]): string {
    let parent = category.parentId;

    let parentTitle = [];
    parentTitle.push('/');
    while (parent && parent !== "root") {
      const parentCategory = categories.find(c => c._id === parent);
      if (parentCategory) {
        parentTitle.push(parentCategory.title);
        parent = parentCategory.parentId;
      } else {
        break;
      }
    }
    return `${parentTitle.reverse().join("/")}${category.title}`;
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}
