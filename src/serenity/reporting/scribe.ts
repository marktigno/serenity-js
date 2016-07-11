import {DomainEvent, ScenarioCompleted, ScenarioStarted, StepCompleted, StepStarted} from '../domain/events';
import {Outcome, Result, Scenario, Screenshot, Step} from '../domain/model';
import {Outlet} from './outlet';
import {parse} from 'stack-trace';

import * as _ from 'lodash';
import * as path from 'path';

export class Scribe {

    constructor(private outlet: Outlet) { }

    write(report: any, pathToFile: string): PromiseLike<string> {
        return this.outlet.sendJSON(pathToFile, report);
    }
}

// states:
// - ready to report scenario - initial state
// - reporting scenario       - after ScenarioStarted
// todo: maybe FSM per report?

export class SerenityReporter {

    reportOn(events: DomainEvent<any>[]): Promise<any[]> {

        return events.reduce( (reports, event, index, list) => {

            switch (event.constructor.name) {

                case ScenarioStarted.name:      return reports.scenarioStarted(event.value, event.timestamp);

                case StepStarted.name:          return reports.stepStarted(event.value, event.timestamp);

                case StepCompleted.name:        return reports.stepCompleted(event.value, event.timestamp);

                case ScenarioCompleted.name:    return reports.scenarioCompleted(event.value, event.timestamp);

                default:                        break;
            }

            return reports;
        }, new SerenityReports()).extract();
    }
}

class SerenityReports {
    private reports: {[key: string]: ScenarioReport} = {};
    private last: SerenityReport<any>;

    scenarioStarted(scenario: Scenario, timestamp: number) {
        let report = new ScenarioReport(scenario, timestamp);

        this.reports[scenario.id] = report;
        this.last                 = report;

        return this;
    }

    stepStarted(step: Step, timestamp: number) {
        let report = new StepReport(step, timestamp);

        this.last.append(report);
        this.last = report;

        return this;
    }

    stepCompleted(outcome: Outcome<Step>, timestamp: number) {

        this.last.completedWith(outcome, timestamp);
        this.last = this.last.parent;

        return this;
    }

    scenarioCompleted(outcome: Outcome<Scenario>, timestamp: number) {
        this.reports[outcome.subject.id].completedWith(outcome, timestamp);

        return this;
    }

    extract(): Promise<any[]> {
        return Promise.all(_.values<ScenarioReport>(this.reports).map((report) => report.toJSON()));
    }
}

interface ErrorStackFrame {
    declaringClass: string;
    methodName:     string;
    fileName:       string;
    lineNumber:     number;
}

abstract class SerenityReport<T> {
    protected children:  StepReport[] = [];
    protected result:    Result;
    protected error:     Error;
    protected startedAt: number;
    protected duration:  number;
    public    parent:    SerenityReport<any>;

    constructor(startTimestamp: number) {
        this.startedAt = startTimestamp;
    }

    append(stepExecutionReport: StepReport) {
        let report = stepExecutionReport;

        report.parent = this;

        this.children.push(report);
    }

    completedWith(outcome: Outcome<T>, finishedAt: number) {
        this.result   = outcome.result;
        this.error    = outcome.error;
        this.duration = finishedAt - this.startedAt;
    }

    abstract toJSON(): PromiseLike<any>;

    protected errorIfPresent() {
        if (! this.error) {
            return undefined; // so that the field is not rendered (that's what Serenity JVM expects for now)
        }

        return {
            'errorType':    this.error.name,
            'message':      this.error.message,
            'stackTrace':   this.stackTraceOf(this.error),
        };
    }

    protected mapAll<I>(items: PromiseLike<I>[], mapper: (I) => any = (x) => x): PromiseLike<any[]> {
        return Promise.all<I>(items).then( (all) => all.map(mapper) );
    }

    protected ifNotEmpty<T>(list: T[]): T[] {
        return !! list.length ? list : undefined;
    }

    private stackTraceOf(error: Error): Array<ErrorStackFrame> {
        return parse(error).map((frame) => {
            return {
                declaringClass: frame.getTypeName() || frame.getFunctionName() || '',
                methodName:     frame.getMethodName() || frame.getFunctionName() || '',
                fileName:       frame.getFileName(),
                lineNumber:     frame.getLineNumber(),
            };
        });
    }
}

class ScenarioReport extends SerenityReport<Scenario> {

    constructor(private scenario: Scenario, startTimestamp: number) {
        super(startTimestamp);
    }

    toJSON(): PromiseLike<any> {
        return this.mapAll(this.children.map((r) => r.toJSON())).then( (serialisedChildren) => {

            return {
                name:           this.scenario.name,
                title:          this.scenario.name,     // todo: do we need both the name and the title?
                description:    '',                     // todo: missing
                tags: [],                               // todo: missing
                // driver                               // todo: missing
                startTime:      this.startedAt,
                manual:         false,
                duration:       this.duration,
                result:         Result[this.result],
                testSteps:      serialisedChildren,
                userStory: {
                    id:         this.dashify(this.scenario.category),
                    storyName:  this.scenario.category,
                    path:       path.relative(process.cwd(), this.scenario.path),   // todo: introduce some relative path resolver
                    type:       'feature',
                },
                testFailureCause: this.errorIfPresent(),
            };
        });
    }

    private dashify(name: string) {
        let dashified = name
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[ \t\W]/g, '-')
            .replace(/^-+|-+$/g, '');

        return dashified.toLowerCase();
    }
}

class StepReport extends SerenityReport<Step> {
    private promisedScreenshots: PromiseLike<Screenshot>[];

    constructor(private step: Step, startTimestamp: number) {
        super(startTimestamp);

        this.promisedScreenshots = step.promisedScreenshots;
    }

    completedWith(outcome: Outcome<Step>, finishedAt: number) {
        super.completedWith(outcome, finishedAt);

        this.promisedScreenshots = this.promisedScreenshots.concat(outcome.subject.promisedScreenshots);
    }

    toJSON(): PromiseLike<any> {
        return this.mapAll(this.promisedScreenshots, this.serialise).then( (serialisedScreenshots) => {
            return this.mapAll(this.children.map((r) => r.toJSON())).then( (serialisedChildren) => {
                return {
                    description: this.step.name,
                    startTime:   this.startedAt,
                    duration:    this.duration,
                    result:      Result[this.result],
                    children:    serialisedChildren,
                    exception:   this.errorIfPresent(),
                    screenshots: this.ifNotEmpty(serialisedScreenshots),
                };
            });
        });
    }

    private serialise(screenshot: Screenshot) {
        return { screenshot: path.basename(screenshot.path) };
    }
}