import { protractor } from 'protractor';
import { Enter, PerformsTasks, step, Task } from 'serenity-js/lib/screenplay-protractor';

import { TodoList } from '../user_interface/todo_list';

export class AddATodoItem implements Task {

    public static called(name: string): AddATodoItem {
        return new AddATodoItem(name);
    }

    @step('{0} adds a todo item called "#name"')
    performAs(actor: PerformsTasks): PromiseLike<void> {
        return actor.attemptsTo(
            Enter.theValue(this.name)
                .into(TodoList.What_Needs_To_Be_Done)
                .thenHit(protractor.Key.ENTER)
        );
    }

    constructor(private name: string) {
    }
}
