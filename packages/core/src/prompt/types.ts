export type PromptName = 'main-agent';

export type PromptData = {
  name: PromptName;
  version: string;
  hash: string;
  text: string;
};

export type PromptRegistry = {
  [key in PromptName]: {
    [version: string]: string;
  };
};
