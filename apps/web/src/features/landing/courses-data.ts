export type PublicCourse = {
  id: string;
  title: string;
  description: string;
  units: { title: string; topics: string }[];
};

export const publicCourses: PublicCourse[] = [
  {
    id: 'maths-for-ml',
    title: 'Mathematics for Machine Learning',
    description:
      'The linear algebra, calculus and probability that machine learning uses, as a course of its own.',
    units: [
      {
        title: 'Linear algebra',
        topics:
          'Vectors, dot products and cosine similarity, matrices, determinants, inverses and linear systems, rank and span, orthogonality and projections, eigenvalues and the SVD.',
      },
      {
        title: 'Calculus',
        topics: 'Derivatives, partial derivatives, the chain rule and gradient vectors.',
      },
      {
        title: 'Probability and statistics',
        topics:
          'Probability, mean and variance, the Gaussian distribution, maximum likelihood, and entropy, cross-entropy and KL divergence.',
      },
    ],
  },
  {
    id: 'ml-foundations',
    title: 'Machine Learning Foundations',
    description: 'How a model learns from data, with the maths taught as each model needs it.',
    units: [
      {
        title: 'ML fundamentals',
        topics:
          'Supervised learning, linear regression, loss functions, gradient descent and train and test splits, with the vectors, matrices and derivatives they use.',
      },
      {
        title: 'Probability and classification',
        topics:
          'The Gaussian, maximum likelihood, logistic regression and cross-entropy, softmax for many classes, and evaluation metrics.',
      },
    ],
  },
  {
    id: 'deep-learning',
    title: 'Deep Learning',
    description:
      'Neural networks from single neurons to convolutional networks and autoencoders, and how to train them well.',
    units: [
      {
        title: 'Neural networks',
        topics:
          'Neurons, activation functions, layers and the forward pass, computational graphs, backpropagation, automatic differentiation and PyTorch.',
      },
      {
        title: 'Deep learning practice',
        topics:
          'Minibatches, momentum and Adam, initialization and normalization, overfitting and regularization, debugging training runs, convolutional networks and autoencoders.',
      },
    ],
  },
  {
    id: 'transformers-llms',
    title: 'Transformers and LLMs',
    description:
      'How language models work and are trained, from tokens and attention to fine-tuning and reinforcement learning.',
    units: [
      {
        title: 'Transformers and LLMs',
        topics:
          'Tokenization, embeddings, attention and multi-head attention, positional representations, transformer blocks, causal masking, language modelling, mixture of experts and pretraining at scale.',
      },
      {
        title: 'Post-training LLMs',
        topics:
          'Supervised fine-tuning, LoRA, reward models from preferences, RLHF, DPO, reinforcement learning with verifiable rewards, reward hacking and evaluating LLMs.',
      },
    ],
  },
  {
    id: 'llm-inference',
    title: 'LLM Inference',
    description:
      'What makes inference slow, from memory bandwidth to the KV cache, and how serving systems speed it up.',
    units: [
      {
        title: 'Inference',
        topics:
          'Measuring inference, prefill and decode, memory-bound and compute-bound work, GPUs, the KV cache, fast attention kernels, quantisation, speculative decoding, serving and ML compilers.',
      },
    ],
  },
  {
    id: 'reinforcement-learning',
    title: 'Reinforcement Learning',
    description:
      'Learning from reward, from decision problems to PPO and training agents in simulation.',
    units: [
      {
        title: 'Reinforcement learning',
        topics:
          'Markov decision processes, policies and returns, value functions and Bellman equations, Q-learning, exploration, deep Q-learning, policy gradients, PPO, reward design and simulation environments.',
      },
    ],
  },
];
