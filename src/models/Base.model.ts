import { action, makeObservable, observable } from "mobx"

export class BaseModel {
  @observable id!: string

  static create<M extends BaseModel>(this: new () => M): M {
    const model = new this()
    makeObservable(model)
    if (!model.id) model.id = crypto.randomUUID()
    return model
  }

  static fromProps<M extends BaseModel>(
    this: { new (): M; create(): BaseModel },
    props: Partial<M>
  ): M {
    const model = this.create() as M
    model.setProps(props)
    return model
  }

  @action setProps(props: Partial<this>) {
    Object.assign(this, props)
  }
}
