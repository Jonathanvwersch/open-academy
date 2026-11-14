import copy
import torch

from data import data


def experiment(candidate, seed=7):
    (train, yt), (validation, yv), (test, ys) = data()
    train, validation, test = candidate.normalize(train, validation, test)
    records = []
    states = []
    for decay in (0.0, 0.01):
        model = candidate.build_model(seed)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.01, weight_decay=decay)
        for epoch in range(12):
            candidate.train_epoch(model, train, yt, optimizer, 32, seed + epoch)
            train_loss, _ = candidate.evaluate(model, train, yt)
            validation_loss, accuracy = candidate.evaluate(model, validation, yv)
            records.append(dict(weight_decay=decay, epoch=epoch + 1,
                                train_loss=train_loss, validation_loss=validation_loss,
                                validation_accuracy=accuracy))
            states.append(copy.deepcopy(model.state_dict()))
    selected = candidate.choose_checkpoint(records)
    model.load_state_dict(states[selected])
    test_loss, test_accuracy = candidate.evaluate(model, test, ys)
    return records, selected, test_loss, test_accuracy
