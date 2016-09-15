import * as _ from 'lodash';
import * as Promise from 'bluebird';
import * as util from 'util';

import * as natural from 'natural';
import { classifier, GenerateClassifier, TopicCollection, Classifiers } from './classifier';
import { grabTopics } from './helpers';

export { TopicCollection } from './classifier';

export interface Intent {
  action: string;
  topic: string;
  details?: any;
}

export interface User {
  conversation?: Array<string>;
  state: any;
  intent: Intent;
}

export interface IntentFunction {
  (text: string, user?: User): Promise<Intent>;
}

export interface SkillFunction {
  (user: User): Promise<User>;
}

export interface ReducerFunction {
  (intents: Array<Intent>, user?: User): Promise<Intent>;
}

const defaultClassifierDirectories: Array<string> = [`${__dirname}/../nlp/phrases`];

export default class ChatBot {
  public classifiers: Classifiers;
  private intents: Array<IntentFunction>;
  private skills: Array<SkillFunction>;
  private reducer: ReducerFunction;
  private debugOn: Boolean;

  constructor(classifierFiles: Array<string|TopicCollection> = []) {
    const allClassifiers = GenerateClassifier(classifierFiles.concat(defaultClassifierDirectories));
    this.classifiers = allClassifiers;
    // console.log(_.keys(this.classifiers));
    this.intents = [ baseBotTextNLP.bind(this), grabTopics.bind(this) ];
    this.skills = [];
    this.reducer = defaultReducer.bind(this);
    this.debugOn = false;
    return this;
  }

  public unshiftIntent(newIntent: IntentFunction) {
    this.intents = [].concat(newIntent.bind(this), this.intents);
    return this;
  }

  public unshiftSkill(newSkill: SkillFunction) {
    this.skills = [].concat(newSkill.bind(this), this.skills);
    return this;
  }

  public setReducer(newReducer: ReducerFunction) {
    this.reducer = newReducer.bind(this);
    return this;
  }

  public turnOnDebug() {
    this.debugOn = true;
    return this;
  }

  public retrainClassifiers(classifierFiles: Array<string|TopicCollection> = []) {
    const allClassifiers = GenerateClassifier(classifierFiles.concat(defaultClassifierDirectories));
    this.classifiers = allClassifiers;
  }

  public createEmptyIntent(): Intent {
    return {
      action: null,
      details: {},
      topic: null,
    };
  }

  public createEmptyUser(defaults: any = {}): User {
    const anEmptyUser: User = {
      conversation: [],
      intent: this.createEmptyIntent(),
      state: 'none',
    };
    return _.defaults(anEmptyUser, defaults) as User;
  }

  public processText<U extends User>(user: U, text: string): Promise<U> {
    if (typeof user.conversation === 'undefined') {
      user.conversation = [];
    }
    user.conversation = user.conversation.concat(text);
    return Promise.map(this.intents, intent => intent(text, user))
      .then(_.flatten)
      .then(_.compact)
      .then((intents: Array<Intent>) => this.reducer(intents, user))
      .then(intent => {
        user.intent = intent;
        for (let i = 0; i < this.skills.length; i++) {
          const result = this.skills[i](user);
          if (result !== null) {
            return result;
          }
        }
        return null;
      })
      .then(() => Promise.resolve(user));
  }
}

interface Classification {
  label: string;
  topic: string;
  value: number;
}

function checkUsingClassifier(text: string, classifier: any, label: string, topic: string): Classification {
  const result = classifier.getClassifications(text)[0];
  if (result.label === 'false') {
    return null;
  }
  return {
    label: label.replace('-', ' '),
    topic,
    value: result.value,
  };
}

export function baseBotTextNLP(text: string): Promise<Array<Intent>> {
  const filtered: Array<Array<Classification>> = _.map(this.classifiers, (classifiers: Classifiers, topic: string) => {
    const trueClassifications = _.map(classifiers, (classifier, label) => checkUsingClassifier(text, classifier, label, topic));
    // console.log(topic, trueClassifications);
    return _.compact(trueClassifications);
  });

  let compacted: Array<Classification> = _.compact(_.flatten(filtered));
  if (this && this.debugOn) { console.log('compacted', util.inspect(compacted, { depth: null })); };

  if (classifier === natural.LogisticRegressionClassifier) {
    compacted = compacted.filter(result => result.value > 0.6);
  }

  if (compacted.length === 0) {
    return null;
  }
  const sorted: Array<Classification> = _.orderBy(compacted, ['value'], 'desc');
  if (this && this.debugOn) { console.log(`${text}\n${util.inspect(sorted, { depth:null })}`); };

  const locations: Array<string> = _.compact(sorted.map((intent) => intent.topic === 'locations' ? _.startCase(intent.label) : null));

  const intents: Array<Intent> = sorted.map(intent => {
    const baseIntent: Intent = {
      action: intent.label,
      details: {
        confidence: intent.value,
        locations,
      },
      topic: intent.topic,
    };

    switch(intent.topic) {
      case 'locations':
        baseIntent.details.locations = locations;
        break;
    }

    return baseIntent;
  });

  return Promise.resolve(intents);
}

export function defaultReducer(intents: Array<Intent>): Promise<Intent> {
  return Promise.resolve(_.compact(intents))
    .then((validIntents: Array<Intent>) => {
      if (this.debugOn) { console.log('validIntents', util.inspect(validIntents, { depth: null })); };
      if (validIntents.length === 0) {
        const unknownIntent: Intent = { action: 'none', topic: null };
        return unknownIntent;
      }
      const mergedDetails = _.defaults.apply(this, validIntents.map(intent => intent.details));
      const firstIntent = validIntents[0];
      firstIntent.details = mergedDetails;
      if (this.debugOn) { console.log(firstIntent); };
      return firstIntent;
    });
}
