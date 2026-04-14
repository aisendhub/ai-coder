import { action, observable } from "mobx"
import { BaseModel } from "./Base.model"

export class BaseList<TItem extends typeof BaseModel> extends BaseModel {
  get ItemType(): TItem {
    return BaseModel as TItem
  }

  @observable items: InstanceType<TItem>[] = []

  @action setItems(items: InstanceType<TItem>[]) {
    this.items.splice(0, this.items.length, ...items)
  }

  @action addItem(item: InstanceType<TItem>) {
    const existing = item.id && this.items.find((i) => i.id === item.id)
    if (existing) {
      existing.setProps(item)
    } else {
      this.items.push(item)
    }
  }

  @action removeItem(id: string) {
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx !== -1) this.items.splice(idx, 1)
  }

  @action setItemsFromJson(items: Parameters<TItem["fromProps"]>[0][]) {
    const created = items.map((item) => this.ItemType.fromProps(item))
    this.setItems(created as InstanceType<TItem>[])
  }

  @action addItemFromJson(item: Parameters<TItem["fromProps"]>[0]) {
    const created = this.ItemType.fromProps(item)
    this.addItem(created as InstanceType<TItem>)
  }

  find(id: string): InstanceType<TItem> | undefined {
    return this.items.find((i) => i.id === id)
  }

  @action setFromJson(json: { items?: unknown[] } & Record<string, unknown>) {
    const { items, ...props } = json
    if (items)
      this.setItemsFromJson(items as Parameters<TItem["fromProps"]>[0][])
    this.setProps(props as Partial<this>)
  }
}
